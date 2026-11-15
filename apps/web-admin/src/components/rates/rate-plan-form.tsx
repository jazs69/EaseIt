'use client';

/**
 * Create or edit one rate plan, with a price per room type.
 *
 * ===========================================================================
 * ONE COMPONENT FOR BOTH, because the two forms differ in exactly two ways:
 * `code` is settable only on create, and an edit sends only what changed. A
 * second component would duplicate the assignment table, the money inputs and
 * the error mapping, and the three would drift.
 *
 * THE F2 CHANGE. F1 had one rate for the whole plan. A plan now carries one
 * rate per room type, so the picker became a small table: tick a category,
 * give it a price. "BAR = 1,500 Standard / 2,500 Deluxe / 4,000 Suite" is the
 * ordinary case and this is where it is expressed.
 *
 * UNTICKING A CATEGORY THAT HAS DATE OVERRIDES IS CALLED OUT, because saving
 * removes the assignment and its calendar cascades away with it. That is the
 * correct meaning of "this plan no longer prices that category", but it is not
 * recoverable, so the form says how many nights will go rather than letting an
 * operator discover it afterwards. Re-ticking a category that was never
 * unticked keeps its calendar: the server applies the set as a diff.
 *
 * MONEY IS ENTERED IN MAJOR UNITS AND SENT IN MINOR UNITS, converted once,
 * here, at the boundary. No arithmetic is performed on a rate anywhere else in
 * the UI (CLAUDE.md section 3.4). The conversion rounds rather than truncates.
 *
 * CURRENCY IS DISPLAYED, NEVER CHOSEN. The API takes the property's own and
 * refuses anything else, so offering a picker would be offering a refusal.
 *
 * FIELD ERRORS COME FROM THE API, not from a second copy of the rules — the
 * server answers `details.issues` keyed by field path, including indexed paths
 * like `roomTypes.1.defaultRate.currency`, and those are mapped straight onto
 * the inputs. The only client-side guards are the ones that would otherwise
 * let a plainly empty form make a round trip.
 * ===========================================================================
 */

import { useId, useState, useTransition } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';

import {
  RATE_PLAN_KIND_LABELS,
  type CreateRatePlanRequest,
  type RatePlanKind,
  type RatePlanView,
  type RoomTypeListResponse,
  type UpdateRatePlanRequest,
} from '@repo/types';
import { Button } from '@repo/ui/components/button';

import { ApiRequestError } from '@/lib/api';
import { createRatePlan, updateRatePlan } from '@/lib/properties-client';

const KINDS = Object.keys(RATE_PLAN_KIND_LABELS) as RatePlanKind[];

/** Field-keyed messages the API returned, if any. */
function issuesFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiRequestError)) return {};
  const issues = error.details?.['issues'];
  if (typeof issues !== 'object' || issues === null) return {};

  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(issues as Record<string, unknown>)) {
    if (typeof value === 'string') mapped[key] = value;
  }
  return mapped;
}

/**
 * Minor units to the string a number input should show.
 *
 * Trailing `.00` is dropped so a whole-rupee rate reads as `3500`, which is
 * how an operator says it.
 */
function toMajorInput(amountMinor: number): string {
  const major = amountMinor / 100;
  return Number.isInteger(major) ? String(major) : major.toFixed(2);
}

/** Per-room-type editor state. `rate` is a major-unit string while typing. */
interface Draft {
  selected: boolean;
  rate: string;
  baseOccupancy: string;
  /** Nights already priced away from the default. 0 for a new assignment. */
  overrideCount: number;
}

interface Props {
  hotelId: string;
  /** Null when creating. */
  plan: RatePlanView | null;
  roomTypes: RoomTypeListResponse;
  /** The property's currency. Displayed; never editable. */
  currency: string;
  onSaved: (plan: RatePlanView) => void;
  onCancel: () => void;
}

export function RatePlanForm({ hotelId, plan, roomTypes, currency, onSaved, onCancel }: Props) {
  const editing = plan !== null;
  const formId = useId();

  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [kind, setKind] = useState<RatePlanKind>(plan?.kind ?? 'STANDARD');
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));

  /**
   * One draft per room type the property has, keyed by id.
   *
   * Built from every category rather than only the assigned ones, so ticking a
   * new category needs no separate "add" step — and its default rate is
   * seeded from the room type's own rack rate, which is the most useful
   * starting number available.
   */
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const assigned = new Map((plan?.roomTypes ?? []).map((entry) => [entry.roomTypeId, entry]));

    return Object.fromEntries(
      roomTypes.items.map((roomType) => {
        const existing = assigned.get(roomType.id);
        return [
          roomType.id,
          {
            selected: existing !== undefined,
            rate: toMajorInput(existing?.defaultRate.amountMinor ?? roomType.baseRate.amountMinor),
            baseOccupancy: String(existing?.baseOccupancy ?? 2),
            overrideCount: existing?.overrideCount ?? 0,
          } satisfies Draft,
        ];
      }),
    );
  });

  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function patchDraft(roomTypeId: string, patch: Partial<Draft>): void {
    setDrafts((previous) => {
      const current = previous[roomTypeId];
      if (current === undefined) return previous;
      return { ...previous, [roomTypeId]: { ...current, ...patch } };
    });
  }

  const chosen = roomTypes.items.filter((roomType) => drafts[roomType.id]?.selected === true);

  /**
   * Categories being removed that currently carry date overrides.
   *
   * Only meaningful while editing: on create nothing can be losing a calendar.
   */
  const losingCalendars = editing
    ? (plan?.roomTypes ?? []).filter(
        (entry) => entry.overrideCount > 0 && drafts[entry.roomTypeId]?.selected !== true,
      )
    : [];

  function submit(): void {
    setIssues({});
    setFormError(null);

    if (chosen.length === 0) {
      setIssues({ roomTypes: 'Choose at least one room type and give it a rate.' });
      return;
    }

    // Each chosen category must carry a usable number. Checked here only to
    // avoid a round trip for an empty box; every other rule is the API's.
    const assignments: { roomTypeId: string; amountMinor: number; baseOccupancy: number }[] = [];
    for (const roomType of chosen) {
      const draft = drafts[roomType.id];
      if (draft === undefined) continue;

      const major = Number(draft.rate);
      if (draft.rate.trim().length === 0 || !Number.isFinite(major)) {
        setIssues({ [`rate.${roomType.id}`]: `Enter a nightly rate for ${roomType.code}.` });
        return;
      }

      assignments.push({
        roomTypeId: roomType.id,
        // Major to minor, once, at the boundary. Rounded, not truncated.
        amountMinor: Math.round(major * 100),
        baseOccupancy: Number(draft.baseOccupancy),
      });
    }

    const roomTypesPayload = assignments.map((entry) => ({
      roomTypeId: entry.roomTypeId,
      defaultRate: { amountMinor: entry.amountMinor, currency },
      baseOccupancy: entry.baseOccupancy,
    }));

    startTransition(() => {
      void (async () => {
        try {
          const saved = editing
            ? await updateRatePlan(hotelId, plan.id, {
                name,
                description: description.trim().length === 0 ? null : description,
                kind,
                roomTypes: roomTypesPayload,
                sortOrder: Number(sortOrder),
              } satisfies UpdateRatePlanRequest)
            : await createRatePlan(hotelId, {
                code,
                name,
                ...(description.trim().length === 0 ? {} : { description }),
                kind,
                roomTypes: roomTypesPayload,
                sortOrder: Number(sortOrder),
              } satisfies CreateRatePlanRequest);

          onSaved(saved);
        } catch (error) {
          const fieldIssues = issuesFrom(error);
          if (Object.keys(fieldIssues).length > 0) {
            setIssues(fieldIssues);
            return;
          }
          // A conflict (duplicate code or name) or anything else: the API's own
          // message is readable and is shown as-is rather than replaced with
          // "something went wrong".
          setFormError(
            error instanceof Error ? error.message : 'The rate plan could not be saved.',
          );
        }
      })();
    });
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${formId}-code`}
          label="Code"
          hint={editing ? 'Not editable — reports and channel mappings point at it.' : 'e.g. BAR'}
          error={issues['code']}
        >
          <input
            id={`${formId}-code`}
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase());
            }}
            disabled={editing || pending}
            maxLength={16}
            autoComplete="off"
            className={inputClass(issues['code'] !== undefined)}
          />
        </Field>

        <Field id={`${formId}-name`} label="Name" error={issues['name']}>
          <input
            id={`${formId}-name`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            disabled={pending}
            maxLength={120}
            autoComplete="off"
            className={inputClass(issues['name'] !== undefined)}
          />
        </Field>
      </div>

      <Field
        id={`${formId}-description`}
        label="Description"
        hint="Optional. What this plan is for."
        error={issues['description']}
      >
        <textarea
          id={`${formId}-description`}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
          disabled={pending}
          rows={2}
          maxLength={2000}
          className={`${inputClass(issues['description'] !== undefined)} h-auto py-2`}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${formId}-kind`}
          label="Type"
          hint="A label for your own grouping."
          error={issues['kind']}
        >
          <select
            id={`${formId}-kind`}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as RatePlanKind);
            }}
            disabled={pending}
            className={inputClass(false)}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {RATE_PLAN_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={`${formId}-sort`}
          label="Sort order"
          hint="Lower appears first in the list."
          error={issues['sortOrder']}
        >
          <input
            id={`${formId}-sort`}
            type="number"
            min={0}
            max={999}
            step={1}
            value={sortOrder}
            onChange={(event) => {
              setSortOrder(event.target.value);
            }}
            disabled={pending}
            className={`${inputClass(issues['sortOrder'] !== undefined)} max-w-28 tabular-nums`}
          />
        </Field>
      </div>

      {/* -- Per-room-type rates: the F2 heart of this form ----------------- */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted-foreground">
          Room types and their nightly rates ({currency})
        </legend>

        {roomTypes.items.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            This property has no room types yet. A rate plan has to apply to at least one, so create
            a category on the Rooms screen first.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                  <th scope="col" className="w-10 px-3 py-2 font-medium">
                    <span className="sr-only">Included</span>
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Room type
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Nightly rate
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Base occupancy
                  </th>
                </tr>
              </thead>
              <tbody>
                {roomTypes.items.map((roomType) => {
                  const draft = drafts[roomType.id];
                  if (draft === undefined) return null;
                  const rateError = issues[`rate.${roomType.id}`];

                  return (
                    <tr
                      key={roomType.id}
                      className={`border-b border-border/60 last:border-0 ${
                        draft.selected ? '' : 'opacity-60'
                      }`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={draft.selected}
                          onChange={(event) => {
                            patchDraft(roomType.id, { selected: event.target.checked });
                          }}
                          disabled={pending}
                          aria-label={`Include ${roomType.code} in this plan`}
                          className="size-4 accent-primary"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{roomType.code}</span>{' '}
                        <span className="text-xs text-muted-foreground">{roomType.name}</span>
                        {draft.overrideCount > 0 ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {draft.overrideCount} dated price
                            {draft.overrideCount === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          value={draft.rate}
                          onChange={(event) => {
                            patchDraft(roomType.id, { rate: event.target.value });
                          }}
                          disabled={pending || !draft.selected}
                          aria-label={`Nightly rate for ${roomType.code}`}
                          className={`${inputClass(rateError !== undefined)} max-w-32 text-right tabular-nums`}
                        />
                        {rateError !== undefined ? (
                          <p className="mt-1 text-xs text-destructive" role="alert">
                            {rateError}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          min={1}
                          max={20}
                          step={1}
                          value={draft.baseOccupancy}
                          onChange={(event) => {
                            patchDraft(roomType.id, { baseOccupancy: event.target.value });
                          }}
                          disabled={pending || !draft.selected}
                          aria-label={`Base occupancy for ${roomType.code}`}
                          className={`${inputClass(false)} max-w-20 text-right tabular-nums`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {issues['roomTypes'] !== undefined ? (
          <p className="text-xs text-destructive" role="alert">
            {issues['roomTypes']}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Each category has its own rate. Date-wise prices are set on the rate calendar.
          </p>
        )}

        {/* Removing an assignment cascades its calendar away. Said before it
            happens, with the count, rather than discovered afterwards. */}
        {losingCalendars.length > 0 ? (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Saving will remove {losingCalendars.map((entry) => entry.code).join(', ')} from this
              plan and delete{' '}
              {losingCalendars.reduce((total, entry) => total + entry.overrideCount, 0)} dated price
              {losingCalendars.reduce((total, entry) => total + entry.overrideCount, 0) === 1
                ? ''
                : 's'}
              . That cannot be undone.
            </span>
          </div>
        ) : null}
      </fieldset>

      {formError !== null ? (
        <p
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || roomTypes.items.length === 0}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Create rate plan'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function inputClass(hasError: boolean): string {
  return [
    'h-9 w-full rounded-md border bg-background px-2.5 text-sm',
    'disabled:cursor-not-allowed disabled:opacity-60',
    hasError ? 'border-destructive' : 'border-input',
  ].join(' ');
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
