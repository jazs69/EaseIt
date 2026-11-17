/**
 * IE-02: tenant-scoped export of a property's data as CSV.
 *
 * ===========================================================================
 * `room-types`, `rooms` and `rates` come out in exactly the import's columns
 * (IE-01), so an export is also a template and a re-importable backup: active
 * rows only (the import refuses retired ones), amounts in major units, and a
 * run of nights at one price collapsed into one `fromDate..toDate` row.
 *
 * `reservations` (by arrival date), `folio-lines` (by charge date) and
 * `guests` are operational. `reservations` and `guests` carry personal data:
 * the permission is sensitive and administrators-only by default, and EVERY
 * export writes a DATA_EXPORTED audit row naming the dataset, window, row count
 * and whether personal data left — never the data itself.
 *
 * Built as one string, like the report CSV: windows are capped at 370 days,
 * and a year of folio lines for the largest hotel here is a few megabytes.
 * ===========================================================================
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import {
  MAX_EXPORT_WINDOW_DAYS,
  PERSONAL_DATA_DATASETS,
  Permission,
  type ExportDataset,
  type ExportQuery,
} from '@repo/types';

import { ValidationFailedError } from '../../common/errors/domain-error.js';
import { DataExchangeAuthorizer } from './data-exchange.authorizer.js';
import { DataExchangeRepository } from './data-exchange.repository.js';
import { writeCsv } from './csv.js';
import { collapseRuns, formatMajor } from './export-format.js';

const DAY = 86_400_000;

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export type ExportFile = { filename: string; csv: string; rows: number };

@Injectable()
export class ExportService {
  constructor(
    private readonly repository: DataExchangeRepository,
    private readonly authorizer: DataExchangeAuthorizer,
  ) {}

  async export(
    userId: string,
    hotelId: string,
    dataset: ExportDataset,
    query: ExportQuery,
  ): Promise<ExportFile> {
    const caller = await this.authorizer.authorise(userId, hotelId, [Permission.DATA_EXPORT]);
    const { propertyId } = caller;
    const window = this.window(dataset, query, caller.businessDate);

    let columns: string[];
    let rows: (string | number | null)[][];

    switch (dataset) {
      case 'room-types': {
        columns = [
          'code',
          'name',
          'maxGuests',
          'maxAdults',
          'baseRate',
          'sortOrder',
          'description',
        ];
        rows = (await this.repository.roomTypes(null, propertyId))
          .filter((t) => !t.retired)
          .map((t) => [
            t.code,
            t.name,
            t.maxGuests,
            t.maxAdults,
            formatMajor(t.baseRateMinor, t.currency),
            t.sortOrder,
            t.description,
          ]);
        break;
      }
      case 'rooms': {
        const types = new Map(
          (await this.repository.roomTypes(null, propertyId)).map((t) => [t.id, t.code]),
        );
        columns = ['number', 'roomTypeCode', 'floor', 'notes'];
        rows = (await this.repository.rooms(null, propertyId))
          .filter((r) => !r.retired)
          .map((r) => [r.number, types.get(r.roomTypeId) ?? '', r.floor, r.notes]);
        break;
      }
      case 'rates': {
        columns = ['ratePlanCode', 'roomTypeCode', 'fromDate', 'toDate', 'amount'];
        const defaults = await this.repository.rateDefaults(propertyId);
        rows = defaults.map((d) => [
          d.planCode,
          d.typeCode,
          null,
          null,
          formatMajor(d.amount, d.currency),
        ]);
        const days = await this.repository.rateDays(propertyId, window.from, window.to);
        rows.push(
          ...collapseRuns(days).map((r) => [
            r.planCode,
            r.typeCode,
            r.from,
            r.to,
            formatMajor(r.amount, r.currency),
          ]),
        );
        break;
      }
      case 'reservations': {
        columns = [
          'confirmationCode',
          'status',
          'source',
          'arrivalDate',
          'departureDate',
          'nights',
          'adults',
          'children',
          'roomTypes',
          'rooms',
          'guestFirstName',
          'guestLastName',
          'guestEmail',
          'guestPhone',
          'currency',
          'total',
          'tax',
          'paid',
          'bookedAt',
          'cancelledAt',
        ];
        rows = (await this.repository.reservations(propertyId, window.from, window.to)).map((r) => [
          r.confirmationCode,
          String(r.status),
          String(r.source),
          isoDay(r.arrivalDate),
          isoDay(r.departureDate),
          Math.round((r.departureDate.getTime() - r.arrivalDate.getTime()) / DAY),
          r.adults,
          r.children,
          [...new Set(r.rooms.map((x) => x.roomType.code))].join(' '),
          r.rooms
            .map((x) => x.room?.number)
            .filter((n): n is string => n !== undefined)
            .join(' '),
          r.guestFirstName,
          r.guestLastName,
          r.guestEmail,
          r.guestPhone,
          r.currency.trim(),
          formatMajor(r.totalAmountMinor, r.currency),
          formatMajor(r.taxAmountMinor, r.currency),
          formatMajor(r.paidAmountMinor, r.currency),
          r.createdAt.toISOString(),
          r.cancelledAt?.toISOString() ?? null,
        ]);
        break;
      }
      case 'folio-lines': {
        columns = [
          'chargeDate',
          'confirmationCode',
          'folioNumber',
          'kind',
          'description',
          'amount',
          'currency',
          'paymentMethod',
          'lineId',
          'reversesLineId',
          'postedAt',
        ];
        rows = (await this.repository.folioLines(propertyId, window.from, window.to)).map((l) => [
          l.chargeDate,
          l.confirmationCode,
          l.folioNumber,
          l.kind,
          l.description,
          formatMajor(l.amountMinor, l.currency),
          l.currency.trim(),
          l.paymentMethod,
          l.id,
          l.reversesLineId,
          l.createdAt.toISOString(),
        ]);
        break;
      }
      case 'guests': {
        columns = [
          'guestId',
          'firstName',
          'lastName',
          'email',
          'phone',
          'countryCode',
          'createdAt',
        ];
        rows = (await this.repository.guests(propertyId)).map((g) => [
          g.id,
          g.firstName,
          g.lastName,
          g.email,
          g.phone,
          g.countryCode,
          g.createdAt.toISOString(),
        ]);
        break;
      }
    }

    await this.repository.auditExport({
      propertyId,
      actorUserId: userId,
      event: 'DATA_EXPORTED',
      entityType: 'property',
      entityId: propertyId,
      before: Prisma.DbNull,
      after: {
        dataset,
        fromDate: window.explicit ? window.from : null,
        toDate: window.explicit ? window.to : null,
        rows: rows.length,
        personalData: PERSONAL_DATA_DATASETS.includes(dataset),
      },
    });

    const span = window.explicit ? `-${window.from}-to-${window.to}` : '';
    return {
      filename: `${caller.code}-${dataset}${span}.csv`,
      csv: writeCsv(columns, rows),
      rows: rows.length,
    };
  }

  /** The date window: required for reservations and folio lines; rates default to a year from the business date. */
  private window(
    dataset: ExportDataset,
    query: ExportQuery,
    businessDate: string,
  ): { from: string; to: string; explicit: boolean } {
    const { fromDate, toDate } = query;
    if (fromDate === undefined && toDate === undefined) {
      if (dataset === 'reservations' || dataset === 'folio-lines') {
        throw new ValidationFailedError({ fromDate: 'Choose a date range for this export.' });
      }
      // Rates: the coming year from the PROPERTY's business date, never the
      // server's clock (section 3.3). Configuration datasets ignore the window.
      const start = Date.parse(`${businessDate}T00:00:00Z`);
      return { from: businessDate, to: isoDay(new Date(start + 364 * DAY)), explicit: false };
    }
    if (fromDate === undefined || toDate === undefined) {
      throw new ValidationFailedError({
        [fromDate === undefined ? 'fromDate' : 'toDate']: 'Give both ends of the range.',
      });
    }
    const span =
      (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY + 1;
    if (span < 1) throw new ValidationFailedError({ toDate: 'The range ends before it starts.' });
    if (span > MAX_EXPORT_WINDOW_DAYS) {
      throw new ValidationFailedError({
        toDate: `A range may cover at most ${String(MAX_EXPORT_WINDOW_DAYS)} days.`,
      });
    }
    return { from: fromDate, to: toDate, explicit: true };
  }
}
