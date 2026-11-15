'use client';

/**
 * Occupancy and extra-person pricing, per rate-plan/room-type assignment (F4).
 *
 * ===========================================================================
 * NOTHING IS CALCULATED HERE. Every figure on this screen comes from the
 * server: the allocation (`includedAdults`), each resolved per-guest charge,
 * the nightly total, and the line-by-line explanation. A percentage charge in
 * particular depends on the night's resolved base rate, which depends on F2
 * overrides and F3 rules — so a client that computed it would be guessing at
 * three layers of precedence it cannot see. The preview endpoint exists for
 * exactly this reason.
 *
 * THE PREVIEW IS LABELLED AS A PREVIEW. The calendar keeps showing the F2/F3
 * resolved BASE rate; this panel's total is "for this composition on this
 * night" and says so. Presenting an occupancy-adjusted figure as the base rate
 * would misrepresent what the calendar means.
 *
 * WARNINGS ARE SHOWN BEFORE AND AFTER SAVING. Before, as local bounds hints
 * from `capacity` the server already sent; after, as the server's own
 * `refusals`, which are authoritative. The local hints exist to stop a pointless
 * round trip, never to be the rule.
 * ===========================================================================
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { AlertTriangle, Check, Info, Loader2, Users } from 'lucide-react';

import {
  EXTRA_GUEST_CHARGE_KIND_LABELS,
  type ExtraGuestChargeKind,
  type OccupancyPricingConfig,
  type OccupancyPricingPreview,
  type RatePlanView,
} from '@repo/types';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';

import { ApiRequestError } from '@/lib/api';
import {
  fetchOccupancyPricing,
  previewOccupancyPricing,
  updateOccupancyPricing,
} from '@/lib/properties-client';

const KINDS: ExtraGuestChargeKind[] = ['FIXED', 'PERCENT'];

function formatMoney(amountMinor: number, currency: string): string {
  // Integer minor units in, formatted once for display. No arithmetic is done
  // on this value anywhere in the UI (CLAUDE.md section 3.4).
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

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

function firstMessage(error: unknown, fallback: string): string {
  const issues = issuesFrom(error);
  const first = Object.values(issues)[0];
  if (first !== undefined) return first;
  return error instanceof Error ? error.message : fallback;
}

/** Today at the viewer's own location, as `YYYY-MM-DD`. */
function todayLocal(): string {
  // en-CA formats as YYYY-MM-DD, matching `currentDateInTimeZone` in
  // packages/types.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * A stored charge value as the string its input shows, and back.
 *
 * ===========================================================================
 * BOTH KINDS SCALE BY 100, FOR UNRELATED REASONS, which is why these take no
 * `kind` parameter:
 *
 *   * FIXED is stored in MINOR UNITS and displayed in major units — 50000
 *     paise shows as 500, because there are 100 minor units to the rupee.
 *   * PERCENT is stored in BASIS POINTS and displayed as a percentage — 1250
 *     bps shows as 12.5, because there are 100 basis points to the percent.
 *
 * The coincidence is worth naming rather than relying on silently. The first
 * factor is a property of the CURRENCY: it is 100 for INR and USD, 1000 for
 * KWD and BHD, and 1 for JPY. This repository already assumes 100 throughout
 * its web app (every `amountMinor / 100` in F1, F2 and F3), so F4 matches that
 * assumption rather than inventing a second one — and the assumption is
 * recorded as a known limitation, not fixed here.
 *
 * The second factor is fixed by the definition of a basis point and is safe.
 * ===========================================================================
 */
const MINOR_UNITS_PER_MAJOR = 100;
const BASIS_POINTS_PER_PERCENT = 100;

function toInput(value: number): string {
  // Both divisors are 100; see above.
  const scaled = value / MINOR_UNITS_PER_MAJOR;
  return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(2);
}

function fromInput(text: string): number | null {
  const parsed = Number(text);
  if (text.trim().length === 0 || !Number.isFinite(parsed) || parsed < 0) return null;
  // Rounded, not truncated, and once — at the boundary (CLAUDE.md 3.4).
  return Math.round(parsed * BASIS_POINTS_PER_PERCENT);
}

interface Draft {
  baseOccupancy: string;
  includedChildren: string;
  enabled: boolean;
  adultKind: ExtraGuestChargeKind;
  adultValue: string;
  childKind: ExtraGuestChargeKind;
  childValue: string;
}

function draftFrom(config: OccupancyPricingConfig): Draft {
  return {
    baseOccupancy: String(config.baseOccupancy),
    includedChildren: String(config.includedChildren),
    enabled: config.enabled,
    adultKind: config.adult.kind,
    adultValue: toInput(config.adult.value),
    childKind: config.child.kind,
    childValue: toInput(config.child.value),
  };
}

interface Props {
  hotelId: string;
  plan: RatePlanView | null;
  canManage: boolean;
  /** Bumped by the parent when a base rate changed, so a preview re-runs. */
  reloadKey: number;
  /** Reflects a changed base occupancy back into the plans list. */
  onConfigSaved: () => void;
}

export function OccupancyPricingPanel({
  hotelId,
  plan,
  canManage,
  reloadKey,
  onConfigSaved,
}: Props) {
  const [roomTypeId, setRoomTypeId] = useState<string>('');
  const [config, setConfig] = useState<OccupancyPricingConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  // Preview inputs.
  const [stayDate, setStayDate] = useState<string>(() => todayLocal());
  const [adults, setAdults] = useState('2');
  const [children, setChildren] = useState('1');
  const [infants, setInfants] = useState('0');
  const [preview, setPreview] = useState<OccupancyPricingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const inFlight = useRef<AbortController | null>(null);

  // Keep the room-type choice valid as the selected plan changes.
  const assignments = plan?.roomTypes ?? [];
  const activeRoomTypeId =
    assignments.find((entry) => entry.roomTypeId === roomTypeId)?.roomTypeId ??
    assignments[0]?.roomTypeId ??
    '';

  const load = useCallback(
    async (planId: string, nextRoomTypeId: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setLoading(true);
      setError(null);
      try {
        const response = await fetchOccupancyPricing(hotelId, planId, nextRoomTypeId, {
          signal: controller.signal,
        });
        setConfig(response);
        setDraft(draftFrom(response));
        setPreview(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setConfig(null);
        setDraft(null);
        setError(firstMessage(cause, 'The occupancy configuration could not be loaded.'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [hotelId],
  );

  // Timer-driven, like the sibling panels: it keeps `setLoading` out of the
  // effect's synchronous body and collapses a fast selector change into one
  // request.
  useEffect(() => {
    if (plan === null || activeRoomTypeId === '') return;
    const planId = plan.id;

    const timer = setTimeout(() => {
      void load(planId, activeRoomTypeId);
    }, 120);

    return () => {
      clearTimeout(timer);
    };
    // `reloadKey` is included because a changed base rate — an F2 override or
    // an F3 rule — changes what a PERCENT charge resolves to, so a stale
    // preview would be wrong.
  }, [plan, activeRoomTypeId, reloadKey, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  function patch(next: Partial<Draft>): void {
    setDraft((previous) => (previous === null ? previous : { ...previous, ...next }));
    setNotice(null);
  }

  function save(): void {
    if (draft === null || config === null || plan === null) return;

    setIssues({});
    setError(null);
    setNotice(null);

    const base = Number(draft.baseOccupancy);
    const kids = Number(draft.includedChildren);
    if (!Number.isInteger(base) || base < 1) {
      setIssues({ baseOccupancy: 'At least one guest.' });
      return;
    }
    if (!Number.isInteger(kids) || kids < 0) {
      setIssues({ includedChildren: 'A whole number, zero or more.' });
      return;
    }

    const adultValue = fromInput(draft.adultValue);
    if (adultValue === null) {
      setIssues({ adult: 'Enter a nonnegative amount.' });
      return;
    }
    const childValue = fromInput(draft.childValue);
    if (childValue === null) {
      setIssues({ child: 'Enter a nonnegative amount.' });
      return;
    }

    startTransition(() => {
      void (async () => {
        try {
          const saved = await updateOccupancyPricing(hotelId, plan.id, config.roomTypeId, {
            baseOccupancy: base,
            includedChildren: kids,
            enabled: draft.enabled,
            adult: { kind: draft.adultKind, value: adultValue },
            child: { kind: draft.childKind, value: childValue },
          });
          setConfig(saved);
          setDraft(draftFrom(saved));
          setPreview(null);
          setNotice('Occupancy pricing saved.');
          // The base occupancy is shown on the plans list too.
          onConfigSaved();
        } catch (cause) {
          const fieldIssues = issuesFrom(cause);
          if (Object.keys(fieldIssues).length > 0) {
            setIssues(fieldIssues);
            return;
          }
          setError(firstMessage(cause, 'The configuration could not be saved.'));
        }
      })();
    });
  }

  function runPreview(): void {
    if (plan === null || config === null) return;
    setError(null);
    setPreviewing(true);

    void (async () => {
      try {
        const result = await previewOccupancyPricing(hotelId, plan.id, {
          roomTypeId: config.roomTypeId,
          stayDate: stayDate as OccupancyPricingPreview['stayDate'],
          adults: Number(adults),
          children: Number(children),
          infants: Number(infants),
        });
        setPreview(result);
      } catch (cause) {
        setPreview(null);
        setError(firstMessage(cause, 'That composition could not be priced.'));
      } finally {
        setPreviewing(false);
      }
    })();
  }

  if (plan === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Occupancy &amp; extra-person pricing</CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-xs text-muted-foreground">
          Select a rate plan to configure guest pricing.
        </CardContent>
      </Card>
    );
  }

  if (assignments.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Occupancy &amp; extra-person pricing</CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-xs text-muted-foreground">
          This plan has no room types assigned yet.
        </CardContent>
      </Card>
    );
  }

  const busy = pending || loading;
  const writable = canManage && config !== null && config.isEditable;

  // Local bounds hints, from `capacity` the server already sent. They exist to
  // avoid a pointless round trip; the server's own validation is the rule.
  const draftBase = draft === null ? 0 : Number(draft.baseOccupancy);
  const draftKids = draft === null ? 0 : Number(draft.includedChildren);
  const overCapacity =
    config !== null && Number.isFinite(draftBase) && draftBase > config.capacity.maxGuests;
  const kidsOverBase =
    Number.isFinite(draftBase) && Number.isFinite(draftKids) && draftKids > draftBase;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4 text-muted-foreground" aria-hidden />
          Occupancy &amp; extra-person pricing
          <span className="text-xs font-normal text-muted-foreground">
            {plan.code} — {plan.name}
          </span>
        </CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Charges added <span className="font-medium text-foreground">on top of</span> the
          night&apos;s resolved base rate, for guests beyond the base occupancy. A percentage charge
          moves with the base rate, so an override or a season changes it too.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Room type</span>
            <select
              value={activeRoomTypeId}
              onChange={(event) => {
                setRoomTypeId(event.target.value);
                setNotice(null);
                setIssues({});
              }}
              disabled={busy}
              className="h-9 min-w-48 rounded-md border border-input bg-background px-2 text-sm"
            >
              {assignments.map((entry) => (
                <option key={entry.roomTypeId} value={entry.roomTypeId}>
                  {entry.code} — {entry.name}
                </option>
              ))}
            </select>
          </label>

          {config !== null ? (
            <div className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Room capacity</span>
              <span className="flex h-9 items-center gap-2 text-sm tabular-nums">
                <Badge variant="outline">{config.capacity.maxGuests} guests max</Badge>
                {config.capacity.maxAdults === null ? (
                  <span className="text-muted-foreground">no separate adult limit</span>
                ) : (
                  <Badge variant="outline">{config.capacity.maxAdults} adults max</Badge>
                )}
              </span>
            </div>
          ) : null}

          {loading ? (
            <Loader2
              className="mb-2 size-4 animate-spin text-muted-foreground"
              aria-label="Loading"
            />
          ) : null}
        </div>

        {config !== null && !config.isEditable ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            This plan is paused or archived, so its occupancy pricing is read-only.
          </p>
        ) : null}

        {notice !== null ? (
          <p
            className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
            role="status"
          >
            {notice}
          </p>
        ) : null}

        {error !== null ? (
          <p
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}

        {config !== null && draft !== null ? (
          <>
            {/* -- Configuration ------------------------------------------ */}
            <div className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-muted-foreground">
                  Base occupancy (guests included in the rate)
                </span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={draft.baseOccupancy}
                  onChange={(event) => {
                    patch({ baseOccupancy: event.target.value });
                  }}
                  disabled={!writable || busy}
                  className={inputClass(issues['baseOccupancy'] !== undefined || overCapacity)}
                />
                {issues['baseOccupancy'] !== undefined ? (
                  <span className="text-destructive" role="alert">
                    {issues['baseOccupancy']}
                  </span>
                ) : overCapacity ? (
                  <span className="text-destructive" role="alert">
                    Exceeds this room type&apos;s limit of {config.capacity.maxGuests} guests.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {config.includedAdults} adult{config.includedAdults === 1 ? '' : 's'}
                    {config.includedChildren > 0
                      ? ` and up to ${config.includedChildren} child${
                          config.includedChildren === 1 ? '' : 'ren'
                        }`
                      : ''}{' '}
                    included at {formatMoney(config.defaultRateMinor, config.currency)}.
                  </span>
                )}
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-muted-foreground">
                  Of those, children included
                </span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={1}
                  value={draft.includedChildren}
                  onChange={(event) => {
                    patch({ includedChildren: event.target.value });
                  }}
                  disabled={!writable || busy}
                  className={inputClass(issues['includedChildren'] !== undefined || kidsOverBase)}
                />
                {issues['includedChildren'] !== undefined ? (
                  <span className="text-destructive" role="alert">
                    {issues['includedChildren']}
                  </span>
                ) : kidsOverBase ? (
                  <span className="text-destructive" role="alert">
                    Cannot exceed the base occupancy — included children are a subset of it.
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    A subset of the base occupancy, not an addition to it.
                  </span>
                )}
              </label>

              <label className="flex items-center gap-2 text-xs sm:col-span-2">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => {
                    patch({ enabled: event.target.checked });
                  }}
                  disabled={!writable || busy}
                  className="size-4 accent-primary"
                />
                <span className="font-medium">Charge for guests beyond the base occupancy</span>
              </label>

              {!draft.enabled ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground sm:col-span-2">
                  Extra-guest pricing is off for this assignment. Every composition that fits the
                  room is priced at the base rate, whatever the amounts below say.
                </p>
              ) : null}

              <ChargeField
                label="Each extra adult"
                kind={draft.adultKind}
                value={draft.adultValue}
                currency={config.currency}
                disabled={!writable || busy || !draft.enabled}
                error={issues['adult'] ?? issues['adult.value']}
                onKind={(adultKind) => {
                  patch({ adultKind });
                }}
                onValue={(adultValue) => {
                  patch({ adultValue });
                }}
              />

              <ChargeField
                label="Each extra child"
                kind={draft.childKind}
                value={draft.childValue}
                currency={config.currency}
                disabled={!writable || busy || !draft.enabled}
                error={issues['child'] ?? issues['child.value']}
                onKind={(childKind) => {
                  patch({ childKind });
                }}
                onValue={(childValue) => {
                  patch({ childValue });
                }}
              />

              {writable ? (
                <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                  <Button onClick={save} disabled={busy}>
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Check className="size-4" aria-hidden />
                    )}
                    {pending ? 'Saving…' : 'Save occupancy pricing'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDraft(draftFrom(config));
                      setIssues({});
                      setNotice(null);
                    }}
                    disabled={busy}
                  >
                    Reset
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Changing occupancy pricing needs the manage-rates permission.
                </p>
              )}
            </div>

            {/* -- Preview ------------------------------------------------- */}
            <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-4">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Preview only.</span> Prices one
                  night for one guest composition, using the saved configuration. It creates no
                  booking. The calendar continues to show the base rate, not this total.
                </p>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Night</span>
                  <input
                    type="date"
                    value={stayDate}
                    onChange={(event) => {
                      setStayDate(event.target.value);
                    }}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm tabular-nums"
                  />
                </label>
                {(
                  [
                    { label: 'Adults', value: adults, set: setAdults, min: 1 },
                    { label: 'Children', value: children, set: setChildren, min: 0 },
                    { label: 'Infants', value: infants, set: setInfants, min: 0 },
                  ] as const
                ).map((field) => (
                  <label key={field.label} className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">{field.label}</span>
                    <input
                      type="number"
                      min={field.min}
                      max={20}
                      step={1}
                      value={field.value}
                      onChange={(event) => {
                        field.set(event.target.value);
                      }}
                      className="h-9 w-20 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums"
                    />
                  </label>
                ))}
                <Button variant="outline" onClick={runPreview} disabled={previewing || busy}>
                  {previewing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  Price this night
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Infants are never charged and never count toward the room&apos;s limits.
              </p>

              {preview !== null ? <PreviewResult preview={preview} /> : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * One extra-guest charge: a kind toggle and an amount.
 *
 * The unit label changes with the kind, because the number means two different
 * things — currency for FIXED, percent for PERCENT — and an input that looked
 * the same for both is how somebody types 500 meaning rupees and configures
 * 500%.
 */
function ChargeField({
  label,
  kind,
  value,
  currency,
  disabled,
  error,
  onKind,
  onValue,
}: {
  label: string;
  kind: ExtraGuestChargeKind;
  value: string;
  currency: string;
  disabled: boolean;
  error: string | undefined;
  onKind: (kind: ExtraGuestChargeKind) => void;
  onValue: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <select
          value={kind}
          onChange={(event) => {
            onKind(event.target.value as ExtraGuestChargeKind);
          }}
          disabled={disabled}
          aria-label={`${label}: charge type`}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
        >
          {KINDS.map((option) => (
            <option key={option} value={option}>
              {EXTRA_GUEST_CHARGE_KIND_LABELS[option]}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={value}
            onChange={(event) => {
              onValue(event.target.value);
            }}
            disabled={disabled}
            aria-label={`${label}: amount`}
            className={`${inputClass(error !== undefined)} w-28 text-right tabular-nums`}
          />
          <span className="text-muted-foreground">{kind === 'FIXED' ? currency : '%'}</span>
        </div>
      </div>
      {error !== undefined ? (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      ) : kind === 'PERCENT' ? (
        <span className="text-muted-foreground">
          Of the night&apos;s resolved base rate — so it moves with overrides and seasons.
        </span>
      ) : (
        <span className="text-muted-foreground">A flat amount per guest per night.</span>
      )}
    </div>
  );
}

/**
 * The server's calculation, rendered as given.
 *
 * The breakdown lines, their arithmetic and the refusals are all server-built.
 * This component formats money and lays the lines out; it derives nothing.
 */
function PreviewResult({ preview }: { preview: OccupancyPricingPreview }) {
  const blocked = preview.refusals.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
      {blocked ? (
        <div
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          <span className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-3.5" aria-hidden />
            This composition cannot be priced
          </span>
          <ul className="ml-5 list-disc">
            {preview.refusals.map((refusal) => (
              <li key={`${refusal.code}-${refusal.field ?? 'none'}`}>{refusal.message}</li>
            ))}
          </ul>
          <span className="text-muted-foreground">
            The figures below show the shape of the calculation, not a price.
          </span>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Base rate for {preview.stayDate} is{' '}
        <span className="font-medium text-foreground tabular-nums">
          {formatMoney(preview.baseRateMinor, preview.currency)}
        </span>{' '}
        from{' '}
        <span className="font-medium text-foreground">
          {preview.baseRateSource === 'DATE_OVERRIDE'
            ? 'a dated price'
            : preview.baseRateSource === 'DEFAULT'
              ? 'the room type default'
              : `a ${preview.baseRateSource.toLowerCase()} rule`}
          {preview.baseRateRuleName === null ? '' : ` — ${preview.baseRateRuleName}`}
        </span>
        .
      </p>

      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Nightly price breakdown</caption>
        <tbody>
          {preview.breakdown.map((line, index) => {
            const isTotal = index === preview.breakdown.length - 1;
            return (
              <tr
                key={`${line.label}-${String(index)}`}
                className={isTotal ? 'border-t border-border font-semibold' : ''}
              >
                <td className="py-1.5 pr-3">
                  <span className={isTotal ? '' : 'text-sm'}>{line.label}</span>
                  <p className="text-xs font-normal text-muted-foreground">{line.detail}</p>
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatMoney(line.amountMinor, preview.currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function inputClass(hasError: boolean): string {
  return [
    'h-9 w-full rounded-md border bg-background px-2.5 text-sm',
    'disabled:cursor-not-allowed disabled:opacity-60',
    hasError ? 'border-destructive' : 'border-input',
  ].join(' ');
}
