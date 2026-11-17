/**
 * IE-01: bulk import of room types, rooms and rates into an existing property.
 *
 * ===========================================================================
 * ONE PATH FOR DRY RUN AND COMMIT. Both run the whole import inside one
 * transaction, under a per-property advisory lock, against state read inside
 * that transaction. A dry run then rolls back. So a clean dry run has already
 * been through every CHECK and unique index, and a commit cannot behave
 * differently from the preview except where the data changed in between —
 * which the commit sees, because it re-validates under the same lock.
 *
 * ALL OR NOTHING. Any ERROR row and the commit is refused with nothing
 * written. A commit must quote the digest of the documents a dry run returned,
 * so the operator commits exactly what they reviewed.
 *
 * WHAT IT WILL NOT DO, each refused per row rather than silently skipped:
 *   * reclassify a room (change its category): a deferred operation elsewhere
 *     too, because it moves capacity between counters;
 *   * revive or edit a retired category or room;
 *   * price a derived, archived or inactive plan (as the rate calendar);
 *   * touch `inventory_day`. New categories have no nights until the horizon
 *     is extended, and new rooms add capacity only to nights generated after
 *     them (limitation L1) — the result says so.
 *
 * Columns left out of a header are left alone on update; a column present
 * with an empty cell clears an optional field. Amounts are major units,
 * converted exactly (`fromMajorUnitString`).
 *
 * Every change writes its audit row in the import's transaction, with the same
 * event names as the screens use, plus one DATA_IMPORTED summary.
 * ===========================================================================
 */

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  MAX_IMPORT_RATE_SPAN_DAYS,
  MAX_IMPORT_ROWS,
  Permission,
  businessDateSchema,
  createRoomTypeRequestSchema,
  fromMajorUnitString,
  roomNumberSchema,
  type ImportDocument,
  type ImportRequest,
  type ImportResult,
  type ImportRowResult,
} from '@repo/types';

import {
  TransactionConflictError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { sqlState } from '../../common/errors/sql-state.js';
import { DataExchangeAuthorizer } from './data-exchange.authorizer.js';
import {
  DataExchangeRepository,
  type RatePlanState,
  type RoomState,
  type RoomTypeState,
  type Tx,
} from './data-exchange.repository.js';
import { parseCsv, type CsvRow } from './csv.js';

/** Nights all dated rate rows together may write in one import. */
const MAX_IMPORT_RATE_NIGHTS = 60_000;
const DAY = 86_400_000;

const ROOM_TYPE_COLUMNS = [
  'code',
  'name',
  'maxGuests',
  'maxAdults',
  'baseRate',
  'sortOrder',
  'description',
];
const ROOM_COLUMNS = ['number', 'roomTypeCode', 'floor', 'notes'];
const RATE_COLUMNS = ['ratePlanCode', 'roomTypeCode', 'fromDate', 'toDate', 'amount'];

/** Thrown inside the transaction to roll a dry run (or a refused commit) back. */
class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super('rollback');
  }
}

type Counts = { create: number; update: number; unchanged: number; error: number };
const zeroCounts = (): Counts => ({ create: 0, update: 0, unchanged: 0, error: 0 });

export function importDigest(
  propertyId: string,
  request: Pick<ImportRequest, 'roomTypes' | 'rooms' | 'rates'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        propertyId,
        request.roomTypes ?? '',
        request.rooms ?? '',
        request.rates ?? '',
      ]),
    )
    .digest('hex');
}

@Injectable()
export class ImportService {
  constructor(
    private readonly repository: DataExchangeRepository,
    private readonly authorizer: DataExchangeAuthorizer,
  ) {}

  async run(userId: string, hotelId: string, request: ImportRequest): Promise<ImportResult> {
    const present = (doc: string | undefined): doc is string =>
      doc !== undefined && doc.trim() !== '';
    const needs: Permission[] = [];
    if (present(request.roomTypes) || present(request.rooms)) needs.push(Permission.ROOMS_MANAGE);
    if (present(request.rates)) needs.push(Permission.RATES_MANAGE);
    const { propertyId } = await this.authorizer.authorise(userId, hotelId, needs);

    const digest = importDigest(propertyId, request);
    if (request.mode === 'COMMIT' && request.digest !== digest) {
      throw new ValidationFailedError({
        digest:
          'These documents are not the ones the dry run checked. Run a dry run again, then commit.',
      });
    }

    let result: ImportResult;
    try {
      result = await this.repository.transaction(async (tx) => {
        await this.repository.lockImports(tx, propertyId);
        const run = new ImportRun(this.repository, tx, propertyId, userId, request.mode, digest);
        await run.execute({
          roomTypes: present(request.roomTypes) ? request.roomTypes : undefined,
          rooms: present(request.rooms) ? request.rooms : undefined,
          rates: present(request.rates) ? request.rates : undefined,
        });
        const outcome = run.result();
        if (request.mode === 'DRY_RUN' || !outcome.valid) throw new Rollback(outcome);
        await run.writeAudit();
        return outcome;
      });
    } catch (error) {
      if (error instanceof Rollback) {
        result = error.result;
      } else {
        // Another writer (the rooms screen, say) took a code or number between
        // our read and our write. Nothing was written; trying again re-reads.
        const state = sqlState(error);
        if (state === '23505' || state === '40001' || state === '40P01') {
          throw new TransactionConflictError('import');
        }
        throw error;
      }
    }

    if (request.mode === 'COMMIT' && !result.valid) {
      const issues: Record<string, string> = {};
      for (const row of result.rows.filter((r) => r.outcome === 'ERROR').slice(0, 20)) {
        issues[`${row.document} line ${String(row.line)}`] = row.messages.join(' ');
      }
      throw new ValidationFailedError(issues);
    }
    return result;
  }
}

/** One import, inside its transaction. */
class ImportRun {
  private readonly rows: ImportRowResult[] = [];
  private readonly counts = { roomTypes: zeroCounts(), rooms: zeroCounts(), rates: zeroCounts() };
  private readonly notes: string[] = [];
  private readonly auditRows: Prisma.AuditLogCreateManyInput[] = [];

  private currency = '';
  private typesByCode = new Map<string, RoomTypeState>();
  private roomsByNumber = new Map<string, RoomState>();
  private plansByCode = new Map<string, RatePlanState>();
  private assignments = new Map<string, number>();

  constructor(
    private readonly repository: DataExchangeRepository,
    private readonly tx: Tx,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly mode: 'DRY_RUN' | 'COMMIT',
    private readonly digest: string,
  ) {}

  async execute(docs: Record<ImportDocument, string | undefined>): Promise<void> {
    const property = await this.repository.property(this.tx, this.propertyId);
    this.currency = property.currency.trim();
    const [types, rooms, plans, assignments] = await Promise.all([
      this.repository.roomTypes(this.tx, this.propertyId),
      this.repository.rooms(this.tx, this.propertyId),
      this.repository.ratePlans(this.tx, this.propertyId),
      this.repository.assignments(this.tx, this.propertyId),
    ]);
    this.typesByCode = new Map(types.map((t) => [t.code.toUpperCase(), t]));
    this.roomsByNumber = new Map(rooms.map((r) => [r.number.toUpperCase(), r]));
    this.plansByCode = new Map(plans.map((p) => [p.code.toUpperCase(), p]));
    this.assignments = assignments;

    // Order matters: rooms may name a category created above them, rates both.
    if (docs.roomTypes !== undefined) await this.importRoomTypes(docs.roomTypes);
    if (docs.rooms !== undefined) await this.importRooms(docs.rooms);
    if (docs.rates !== undefined) await this.importRates(docs.rates);

    if (this.counts.roomTypes.create > 0) {
      this.notes.push(
        `${String(this.counts.roomTypes.create)} new categor${this.counts.roomTypes.create === 1 ? 'y has' : 'ies have'} no inventory nights yet: extend the horizon on the Inventory screen before selling ${this.counts.roomTypes.create === 1 ? 'it' : 'them'}.`,
      );
    }
    if (this.counts.rooms.create > 0) {
      this.notes.push(
        'New rooms add capacity to inventory nights generated after this import; nights that already exist keep their room count.',
      );
    }
  }

  result(): ImportResult {
    const errors = this.counts.roomTypes.error + this.counts.rooms.error + this.counts.rates.error;
    return {
      mode: this.mode,
      committed: this.mode === 'COMMIT' && errors === 0,
      digest: this.digest,
      valid: errors === 0,
      counts: this.counts,
      rows: this.rows,
      notes: this.notes,
    };
  }

  async writeAudit(): Promise<void> {
    this.auditRows.push({
      propertyId: this.propertyId,
      actorUserId: this.userId,
      event: 'DATA_IMPORTED',
      entityType: 'property',
      entityId: this.propertyId,
      before: Prisma.DbNull,
      after: { digest: this.digest, counts: this.counts },
    });
    await this.repository.audit(this.tx, this.auditRows);
  }

  /* ------------------------------------------------------------ helpers -- */

  private record(
    document: ImportDocument,
    line: number,
    key: string,
    outcome: ImportRowResult['outcome'],
    messages: string[] = [],
  ): void {
    const bucket = this.counts[document];
    if (outcome === 'CREATE') bucket.create += 1;
    else if (outcome === 'UPDATE') bucket.update += 1;
    else if (outcome === 'UNCHANGED') bucket.unchanged += 1;
    else bucket.error += 1;
    if (outcome !== 'UNCHANGED' || messages.length > 0)
      this.rows.push({ document, line, key, outcome, messages });
  }

  private parse(
    document: ImportDocument,
    text: string,
    allowed: string[],
    required: string[],
  ): CsvRow[] | null {
    const parsed = parseCsv(text, allowed, required, MAX_IMPORT_ROWS);
    if (!parsed.ok) {
      this.record(document, 1, '(document)', 'ERROR', [parsed.error]);
      return null;
    }
    return parsed.rows;
  }

  private amount(cell: string, errors: string[], field: string): number | null {
    if (cell === '') {
      errors.push(`${field} is required.`);
      return null;
    }
    try {
      const value = fromMajorUnitString(cell.replaceAll(',', ''), this.currency).amountMinor;
      if (value < 0) {
        errors.push(`${field} cannot be negative.`);
        return null;
      }
      return value;
    } catch (error) {
      errors.push(
        `${field} "${cell}": ${error instanceof Error ? error.message : 'not an amount'}`,
      );
      return null;
    }
  }

  private integer(
    cell: string | undefined,
    field: string,
    errors: string[],
  ): number | null | undefined {
    if (cell === undefined) return undefined;
    if (cell === '') return null;
    if (!/^\d+$/.test(cell)) {
      errors.push(`${field} must be a whole number, not "${cell}".`);
      return undefined;
    }
    return Number(cell);
  }

  /* --------------------------------------------------------- room types -- */

  private async importRoomTypes(text: string): Promise<void> {
    const rows = this.parse('roomTypes', text, ROOM_TYPE_COLUMNS, [
      'code',
      'name',
      'maxGuests',
      'baseRate',
    ]);
    if (rows === null) return;
    const seen = new Set<string>();

    for (const row of rows) {
      const cell = (name: string): string | undefined => row.cells.get(name);
      const code = cell('code') ?? '';
      const key = code.toUpperCase();
      const errors: string[] = [];
      if (seen.has(key)) {
        this.record('roomTypes', row.line, code, 'ERROR', [
          `Category "${code}" appears more than once in this file.`,
        ]);
        continue;
      }
      seen.add(key);

      const existing = this.typesByCode.get(key);
      if (existing?.retired === true) {
        this.record('roomTypes', row.line, code, 'ERROR', [
          `Category "${existing.code}" is retired and cannot be imported into.`,
        ]);
        continue;
      }

      const baseRate = this.amount(cell('baseRate') ?? '', errors, 'baseRate');
      const maxGuests = this.integer(cell('maxGuests'), 'maxGuests', errors);
      const maxAdults = this.integer(cell('maxAdults'), 'maxAdults', errors);
      const sortOrder = this.integer(cell('sortOrder'), 'sortOrder', errors);
      const descriptionCell = cell('description');

      const candidate = {
        code: existing?.code ?? code,
        name: cell('name') ?? '',
        description:
          descriptionCell === undefined
            ? (existing?.description ?? null)
            : descriptionCell === ''
              ? null
              : descriptionCell,
        maxGuests: maxGuests ?? existing?.maxGuests ?? 0,
        maxAdults: maxAdults === undefined ? (existing?.maxAdults ?? null) : maxAdults,
        baseRateMinor: baseRate ?? 0,
        currency: existing?.currency ?? this.currency,
        sortOrder:
          sortOrder === undefined || sortOrder === null ? (existing?.sortOrder ?? 0) : sortOrder,
      };

      const check = createRoomTypeRequestSchema.safeParse({
        code: candidate.code,
        name: candidate.name,
        ...(candidate.description === null ? {} : { description: candidate.description }),
        maxGuests: candidate.maxGuests,
        ...(candidate.maxAdults === null ? {} : { maxAdults: candidate.maxAdults }),
        baseRate: { amountMinor: candidate.baseRateMinor, currency: candidate.currency },
        sortOrder: candidate.sortOrder,
      });
      if (!check.success) {
        for (const issue of check.error.issues)
          errors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);
      }
      if (existing === undefined) {
        const clash = [...this.typesByCode.values()].find(
          (t) => t.name.toLowerCase() === candidate.name.toLowerCase(),
        );
        if (clash !== undefined)
          errors.push(`The name "${candidate.name}" is already used by category "${clash.code}".`);
      }
      if (errors.length > 0) {
        this.record('roomTypes', row.line, code, 'ERROR', [...new Set(errors)]);
        continue;
      }

      if (existing === undefined) {
        const { id } = await this.repository.createRoomType(this.tx, this.propertyId, candidate);
        const created: RoomTypeState = { id, ...candidate, retired: false };
        this.typesByCode.set(key, created);
        this.auditRows.push(
          this.auditRow('ROOM_TYPE_CREATED', 'room_type', id, null, roomTypeAudit(created)),
        );
        this.record('roomTypes', row.line, candidate.code, 'CREATE');
        continue;
      }

      const changed = (
        ['name', 'description', 'maxGuests', 'maxAdults', 'baseRateMinor', 'sortOrder'] as const
      ).filter((field) => existing[field] !== candidate[field]);
      if (changed.length === 0) {
        this.record('roomTypes', row.line, existing.code, 'UNCHANGED');
        continue;
      }
      const { code: _code, currency: _currency, ...update } = candidate;
      await this.repository.updateRoomType(this.tx, this.propertyId, existing.id, update);
      const after: RoomTypeState = { ...existing, ...update };
      this.typesByCode.set(key, after);
      this.auditRows.push(
        this.auditRow(
          'ROOM_TYPE_UPDATED',
          'room_type',
          existing.id,
          roomTypeAudit(existing),
          roomTypeAudit(after),
        ),
      );
      this.record('roomTypes', row.line, existing.code, 'UPDATE', [
        `Changes ${changed.join(', ')}.`,
      ]);
    }
  }

  /* -------------------------------------------------------------- rooms -- */

  private async importRooms(text: string): Promise<void> {
    const rows = this.parse('rooms', text, ROOM_COLUMNS, ['number', 'roomTypeCode']);
    if (rows === null) return;
    const seen = new Set<string>();

    for (const row of rows) {
      const cell = (name: string): string | undefined => row.cells.get(name);
      const number = cell('number') ?? '';
      const key = number.toUpperCase();
      const errors: string[] = [];
      if (seen.has(key)) {
        this.record('rooms', row.line, number, 'ERROR', [
          `Room "${number}" appears more than once in this file.`,
        ]);
        continue;
      }
      seen.add(key);

      const parsedNumber = roomNumberSchema.safeParse(number);
      if (!parsedNumber.success)
        errors.push(parsedNumber.error.issues[0]?.message ?? 'Invalid room number.');
      const typeCode = cell('roomTypeCode') ?? '';
      const type = this.typesByCode.get(typeCode.toUpperCase());
      if (type === undefined)
        errors.push(`No category "${typeCode}" at this property (nor earlier in this import).`);
      else if (type.retired) errors.push(`Category "${type.code}" is retired.`);

      const optional = (
        name: 'floor' | 'notes',
        max: number,
        current: string | null,
      ): string | null => {
        const value = cell(name);
        if (value === undefined) return current;
        if (value.length > max) errors.push(`${name} may be at most ${String(max)} characters.`);
        return value === '' ? null : value;
      };
      const existing = this.roomsByNumber.get(key);
      const floor = optional('floor', 16, existing?.floor ?? null);
      const notes = optional('notes', 500, existing?.notes ?? null);

      if (existing?.retired === true)
        errors.push(`Room "${existing.number}" is retired and cannot be imported into.`);
      if (existing !== undefined && type !== undefined && existing.roomTypeId !== type.id) {
        const current = [...this.typesByCode.values()].find((t) => t.id === existing.roomTypeId);
        errors.push(
          `Room "${existing.number}" is in category "${current?.code ?? '?'}". Moving a room to another category is not supported by import.`,
        );
      }
      if (errors.length > 0 || type === undefined || !parsedNumber.success) {
        this.record('rooms', row.line, number, 'ERROR', [...new Set(errors)]);
        continue;
      }

      if (existing === undefined) {
        const data = { number: parsedNumber.data, roomTypeId: type.id, floor, notes };
        const { id } = await this.repository.createRoom(this.tx, this.propertyId, data);
        this.roomsByNumber.set(key, { id, ...data, status: 'VACANT_CLEAN', retired: false });
        this.auditRows.push(
          this.auditRow('ROOM_CREATED', 'room', id, null, { ...data, status: 'VACANT_CLEAN' }),
        );
        this.record('rooms', row.line, data.number, 'CREATE');
        continue;
      }
      if (existing.floor === floor && existing.notes === notes) {
        this.record('rooms', row.line, existing.number, 'UNCHANGED');
        continue;
      }
      await this.repository.updateRoom(this.tx, this.propertyId, existing.id, { floor, notes });
      const shape = (r: { floor: string | null; notes: string | null }) => ({
        number: existing.number,
        floor: r.floor,
        roomTypeId: existing.roomTypeId,
        status: existing.status,
        notes: r.notes,
      });
      this.auditRows.push(
        this.auditRow(
          'ROOM_UPDATED',
          'room',
          existing.id,
          shape(existing),
          shape({ floor, notes }),
        ),
      );
      this.roomsByNumber.set(key, { ...existing, floor, notes });
      this.record('rooms', row.line, existing.number, 'UPDATE');
    }
  }

  /* -------------------------------------------------------------- rates -- */

  private async importRates(text: string): Promise<void> {
    const rows = this.parse('rates', text, RATE_COLUMNS, [
      'ratePlanCode',
      'roomTypeCode',
      'amount',
    ]);
    if (rows === null) return;

    type Valid = {
      row: CsvRow;
      key: string;
      plan: RatePlanState;
      type: RoomTypeState;
      amount: number;
      from: string | null;
      to: string | null;
    };
    const valid: Valid[] = [];
    const defaults = new Set<string>();
    const nightsByPair = new Map<string, Map<string, number>>();
    let totalNights = 0;

    for (const row of rows) {
      const cell = (name: string): string => row.cells.get(name) ?? '';
      const errors: string[] = [];
      const planCode = cell('ratePlanCode');
      const typeCode = cell('roomTypeCode');
      const from = cell('fromDate') || null;
      const to = cell('toDate') || null;
      const key = `${planCode}/${typeCode}${from === null ? ' (default)' : ` ${from}..${to ?? ''}`}`;

      const plan = this.plansByCode.get(planCode.toUpperCase());
      if (plan === undefined)
        errors.push(
          `No rate plan "${planCode}" at this property. Create it on the Rates screen first.`,
        );
      else if (plan.derived)
        errors.push(
          `Plan "${plan.code}" is derived from another plan; its prices come from its parent.`,
        );
      else if (plan.archived) errors.push(`Plan "${plan.code}" is archived.`);
      else if (!plan.isActive) errors.push(`Plan "${plan.code}" is inactive.`);
      const type = this.typesByCode.get(typeCode.toUpperCase());
      if (type === undefined)
        errors.push(`No category "${typeCode}" at this property (nor earlier in this import).`);
      else if (type.retired) errors.push(`Category "${type.code}" is retired.`);
      if (
        plan !== undefined &&
        type !== undefined &&
        plan.currency.trim() !== type.currency.trim()
      ) {
        errors.push(
          `Plan "${plan.code}" is in ${plan.currency} but category "${type.code}" is in ${type.currency}.`,
        );
      }
      const amount = this.amount(cell('amount'), errors, 'amount');
      if (amount !== null && amount > 2_000_000_000) errors.push('That rate is implausibly large.');

      if ((from === null) !== (to === null)) {
        errors.push(
          'Give both fromDate and toDate for dated prices, or leave both empty to set the default rate.',
        );
      } else if (from !== null && to !== null) {
        for (const [name, value] of [
          ['fromDate', from],
          ['toDate', to],
        ] as const) {
          if (!businessDateSchema.safeParse(value).success)
            errors.push(`${name} "${value}" is not a real date in YYYY-MM-DD form.`);
        }
        if (errors.length === 0) {
          const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1;
          if (span < 1) errors.push('toDate is before fromDate.');
          else if (span > MAX_IMPORT_RATE_SPAN_DAYS)
            errors.push(`One row may cover at most ${String(MAX_IMPORT_RATE_SPAN_DAYS)} nights.`);
        }
      }

      if (errors.length > 0 || plan === undefined || type === undefined || amount === null) {
        this.record('rates', row.line, key, 'ERROR', [...new Set(errors)]);
        continue;
      }
      const pair = `${plan.id}:${type.id}`;
      if (from === null) {
        if (defaults.has(pair)) {
          this.record('rates', row.line, key, 'ERROR', [
            'The default for this plan and category is set twice in this file.',
          ]);
          continue;
        }
        defaults.add(pair);
      } else if (to !== null) {
        const nights = nightsByPair.get(pair) ?? new Map<string, number>();
        const start = Date.parse(`${from}T00:00:00Z`);
        const end = Date.parse(`${to}T00:00:00Z`);
        const clash: string[] = [];
        for (let t = start; t <= end; t += DAY) {
          const day = new Date(t).toISOString().slice(0, 10);
          if (nights.has(day)) clash.push(day);
        }
        if (clash.length > 0) {
          this.record('rates', row.line, key, 'ERROR', [
            `Overlaps an earlier row in this file on ${clash[0] ?? ''}${clash.length > 1 ? ` and ${String(clash.length - 1)} more night(s)` : ''}.`,
          ]);
          continue;
        }
        for (let t = start; t <= end; t += DAY)
          nights.set(new Date(t).toISOString().slice(0, 10), amount);
        nightsByPair.set(pair, nights);
        totalNights += (end - start) / DAY + 1;
      }
      valid.push({ row, key, plan, type, amount, from, to });
    }

    if (totalNights > MAX_IMPORT_RATE_NIGHTS) {
      this.record('rates', 1, '(document)', 'ERROR', [
        `The dated rows cover ${String(totalNights)} nights; one import may write at most ${String(MAX_IMPORT_RATE_NIGHTS)}. Split the file.`,
      ]);
      return;
    }

    // Defaults first, so a dated row may follow a default that creates the assignment.
    for (const v of valid.filter((x) => x.from === null)) {
      const pair = `${v.plan.id}:${v.type.id}`;
      const before = this.assignments.get(pair);
      if (before === v.amount) {
        this.record('rates', v.row.line, v.key, 'UNCHANGED');
        continue;
      }
      await this.repository.upsertAssignment(
        this.tx,
        this.propertyId,
        v.plan.id,
        v.type.id,
        v.amount,
      );
      this.assignments.set(pair, v.amount);
      this.auditRows.push(
        this.auditRow(
          before === undefined ? 'RATE_PLAN_ROOM_TYPE_ASSIGNED' : 'RATE_PLAN_ROOM_TYPE_REPRICED',
          'rate_plan',
          v.plan.id,
          before === undefined ? null : { roomTypeId: v.type.id, defaultRateMinor: before },
          { roomTypeId: v.type.id, defaultRateMinor: v.amount },
        ),
      );
      this.record('rates', v.row.line, v.key, before === undefined ? 'CREATE' : 'UPDATE');
    }

    for (const v of valid.filter((x) => x.from !== null)) {
      const pair = `${v.plan.id}:${v.type.id}`;
      if (!this.assignments.has(pair)) {
        this.record('rates', v.row.line, v.key, 'ERROR', [
          `Plan "${v.plan.code}" does not price category "${v.type.code}" yet. Add a row with empty dates to set its default rate first.`,
        ]);
        continue;
      }
      const from = v.from ?? '';
      const to = v.to ?? from;
      const current = await this.repository.overrides(
        this.tx,
        this.propertyId,
        v.plan.id,
        v.type.id,
        from,
        to,
      );
      const days: string[] = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
        days.push(new Date(t).toISOString().slice(0, 10));
      }
      const changed = days.filter((d) => current.get(d) !== v.amount);
      if (changed.length === 0) {
        this.record('rates', v.row.line, v.key, 'UNCHANGED');
        continue;
      }
      await this.repository.upsertDays(
        this.tx,
        this.propertyId,
        v.plan.id,
        v.type.id,
        changed,
        changed.map(() => v.amount),
        this.userId,
      );
      const created = changed.filter((d) => !current.has(d)).length;
      this.auditRows.push(
        this.auditRow('RATE_CALENDAR_UPDATED', 'rate_plan_day', v.plan.id, null, {
          roomTypeId: v.type.id,
          ratePlanId: v.plan.id,
          fromDate: from,
          toDate: to,
          dateCount: changed.length,
          created,
          updated: changed.length - created,
          amountMinor: v.amount,
          source: 'import',
        }),
      );
      this.record('rates', v.row.line, v.key, created === changed.length ? 'CREATE' : 'UPDATE', [
        `${String(changed.length)} night(s) priced${changed.length < days.length ? `, ${String(days.length - changed.length)} already at this rate` : ''}.`,
      ]);
    }
  }

  private auditRow(
    event: string,
    entityType: string,
    entityId: string,
    before: Prisma.InputJsonObject | null,
    after: Prisma.InputJsonObject,
  ): Prisma.AuditLogCreateManyInput {
    return {
      propertyId: this.propertyId,
      actorUserId: this.userId,
      event,
      entityType,
      entityId,
      before: before ?? Prisma.DbNull,
      after: { ...after, importDigest: this.digest },
    };
  }
}

function roomTypeAudit(row: RoomTypeState): Prisma.InputJsonObject {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    maxGuests: row.maxGuests,
    maxAdults: row.maxAdults,
    baseRateMinor: row.baseRateMinor,
    currency: row.currency,
    sortOrder: row.sortOrder,
  };
}
