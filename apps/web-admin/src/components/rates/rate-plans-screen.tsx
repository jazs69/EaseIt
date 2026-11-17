'use client';

/**
 * Rate plan management, for one property (scope F1).
 *
 * ===========================================================================
 * WHAT THIS SCREEN SAYS OUT LOUD, AND WHY.
 *
 * A booking prices from a plan only when the clerk picks it in the booking
 * form (F9); otherwise it uses the rack rate. Extra-guest charges, promotions
 * and stay restrictions (AV-07) apply only to plan-priced bookings. The banner
 * says exactly that, because an operator who believed a price or a rule was
 * live when it was not would quote the wrong figure.
 *
 * There is no channel push here, and the banner names that too rather than
 * leaving an operator to discover the absence.
 *
 * NO DELETE CONTROL, because there is no delete endpoint. A plan that has ever
 * been quoted is history. Deactivate is the reversible stop; archive is
 * terminal and the dialog says so.
 *
 * FILTERING IS SERVER-SIDE, through the list endpoint. Filtering a page of
 * already-fetched rows would silently mean "of the ones you happen to have",
 * and the default — active plans only — is a decision the API makes so every
 * client agrees about it.
 *
 * LIST STATE IS UPDATED FROM THE RESPONSE, never patched optimistically. Each
 * write returns the saved plan, and splicing that exact row in is what keeps
 * the table and the database in agreement — an optimistic update would show a
 * rate the server may have normalised.
 * ===========================================================================
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  Archive,
  CirclePause,
  CirclePlay,
  Info,
  Loader2,
  Plus,
  Search,
  Tag,
  X,
} from 'lucide-react';

import {
  RATE_PLAN_KIND_LABELS,
  type ListRatePlansQuery,
  type RatePlanKind,
  type RatePlanView,
  type RoomTypeListResponse,
} from '@repo/types';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';

import { fetchRatePlans, setRatePlanStatus } from '@/lib/properties-client';
import { OccupancyPricingPanel } from './occupancy-pricing-panel';
import { PricingRulesPanel } from './pricing-rules-panel';
import { PromotionsPanel } from './promotions-panel';
import { RateCalendar } from './rate-calendar';
import { RestrictionsPanel } from './restrictions-panel';
import { RatePlanForm } from './rate-plan-form';

type StatusFilter = ListRatePlansQuery['status'];
type PendingAction = { action: 'DEACTIVATE' | 'ARCHIVE'; plan: RatePlanView };

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Paused' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];

const KINDS = Object.keys(RATE_PLAN_KIND_LABELS) as RatePlanKind[];

function formatRate(amountMinor: number, currency: string): string {
  // Integer minor units in, formatted once for display. No arithmetic is done
  // on this value anywhere in the UI (CLAUDE.md section 3.4).
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(amountMinor / 100);
}

/** An ISO-8601 instant as a readable local date. */
function formatInstant(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(iso));
}

interface Props {
  hotelId: string;
  initialPlans: RatePlanView[];
  roomTypes: RoomTypeListResponse;
  currency: string;
  /** True when the signed-in user holds `rates:manage`. */
  canManage: boolean;
}

export function RatePlansScreen({ hotelId, initialPlans, roomTypes, currency, canManage }: Props) {
  const [plans, setPlans] = useState(initialPlans);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [kind, setKind] = useState<RatePlanKind | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'create' | 'edit'>('none');
  const [confirming, setConfirming] = useState<PendingAction | null>(null);

  /**
   * F3 plumbing between the calendar and the rules panel.
   *
   * `pricingPlanId` is the single source of truth for which plan both are
   * looking at -- two local copies would let the grid show one plan's prices
   * while the panel edited another's rules.
   *
   * `rulesVersion` is bumped whenever a rule changes, which makes the calendar
   * re-read: every matching night's effective price has just moved.
   *
   * `inspectRuleId` carries a request from a calendar cell to the panel.
   */
  const [pricingPlanId, setPricingPlanId] = useState<string | null>(null);
  const [rulesVersion, setRulesVersion] = useState(0);
  const [inspectRuleId, setInspectRuleId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The first render already has server-fetched rows for the default filter,
  // so the effect below must not re-fetch them. Skipping the first run is what
  // avoids a redundant request and a visible flash on load.
  const firstRun = useRef(true);
  // Supersedes an in-flight list request when a filter changes again, so a
  // slow earlier response cannot overwrite a newer one.
  const inFlight = useRef<AbortController | null>(null);

  const reload = useCallback(
    async (next: { status: StatusFilter; kind: RatePlanKind | 'ALL'; search: string }) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setLoading(true);
      setListError(null);
      try {
        const response = await fetchRatePlans(
          hotelId,
          {
            status: next.status,
            ...(next.kind === 'ALL' ? {} : { kind: next.kind }),
            ...(next.search.trim().length === 0 ? {} : { search: next.search.trim() }),
          },
          { signal: controller.signal },
        );
        setPlans(response.items);
      } catch (error) {
        // An abort is this component superseding itself, not a failure.
        if (controller.signal.aborted) return;
        setListError(
          error instanceof Error ? error.message : 'The rate plans could not be loaded.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [hotelId],
  );

  // Debounced, because `search` changes on every keystroke and each change
  // would otherwise be a request.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }

    const timer = setTimeout(() => {
      void reload({ status, kind, search });
    }, 250);

    return () => {
      clearTimeout(timer);
    };
  }, [status, kind, search, reload]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const selected = plans.find((plan) => plan.id === selectedId) ?? null;

  // Only plans that can actually be priced are offered to the calendar and the
  // rules panel: active, not archived, and with at least one assignment.
  // Offering a paused plan would be offering a read-only editor with no
  // explanation.
  const pricingPlans = plans.filter(
    (entry) => entry.isActive && entry.archivedAt === null && entry.roomTypes.length > 0,
  );
  const pricingPlan =
    pricingPlans.find((entry) => entry.id === pricingPlanId) ?? pricingPlans[0] ?? null;

  /** Splices the saved row in, or prepends it when it is new. */
  function absorb(saved: RatePlanView, message: string): void {
    setPlans((previous) => {
      const index = previous.findIndex((plan) => plan.id === saved.id);
      if (index === -1) return [saved, ...previous];
      const next = [...previous];
      next[index] = saved;
      return next;
    });
    setSelectedId(saved.id);
    setMode('none');
    setNotice(message);
  }

  function applyStatus(action: PendingAction['action'] | 'ACTIVATE', plan: RatePlanView): void {
    setNotice(null);
    setListError(null);
    startTransition(() => {
      void (async () => {
        try {
          const saved = await setRatePlanStatus(hotelId, plan.id, action);
          const verb =
            action === 'ACTIVATE' ? 'activated' : action === 'DEACTIVATE' ? 'paused' : 'archived';
          absorb(saved, `“${saved.name}” ${verb}.`);
        } catch (error) {
          setListError(error instanceof Error ? error.message : 'The status could not be changed.');
        } finally {
          setConfirming(null);
        }
      })();
    });
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <ScopeNotice />

      {mode === 'create' || mode === 'edit' ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-base">
              {mode === 'create' ? 'New rate plan' : `Edit ${selected?.code ?? ''}`}
            </CardTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close the form"
              onClick={() => {
                setMode('none');
              }}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </CardHeader>
          <CardContent>
            <RatePlanForm
              hotelId={hotelId}
              plan={mode === 'edit' ? selected : null}
              roomTypes={roomTypes}
              currency={currency}
              onSaved={(saved) => {
                absorb(
                  saved,
                  mode === 'create'
                    ? `“${saved.name}” created. Choose it in the booking form to price from it.`
                    : `“${saved.name}” saved.`,
                );
              }}
              onCancel={() => {
                setMode('none');
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-input p-0.5">
              {STATUS_FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setStatus(option.value);
                  }}
                  aria-pressed={status === option.value}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    status === option.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as RatePlanKind | 'ALL');
              }}
              aria-label="Filter by type"
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="ALL">Every type</option>
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {RATE_PLAN_KIND_LABELS[value]}
                </option>
              ))}
            </select>

            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder="Code or name"
                aria-label="Search rate plans"
                className="h-8 w-44 rounded-md border border-input bg-background pr-2 pl-7 text-xs"
              />
            </div>

            {loading ? (
              <Loader2
                className="size-3.5 animate-spin text-muted-foreground"
                aria-label="Loading"
              />
            ) : null}
          </div>

          {canManage ? (
            <Button
              size="sm"
              onClick={() => {
                setMode('create');
                setNotice(null);
              }}
            >
              <Plus className="size-4" aria-hidden />
              New rate plan
            </Button>
          ) : null}
        </div>

        {notice !== null ? (
          <p
            className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
            role="status"
          >
            {notice}
          </p>
        ) : null}

        {listError !== null ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {listError}
          </p>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tag className="size-4 text-muted-foreground" aria-hidden />
              Rate plans
              <span className="text-xs font-normal text-muted-foreground">
                {plans.length} shown
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {plans.length === 0 ? (
              <EmptyState
                filtered={status !== 'active' || kind !== 'ALL' || search.trim().length > 0}
                canManage={canManage}
                onCreate={() => {
                  setMode('create');
                }}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Code
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Name
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Type
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Room types and rates
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map((plan) => (
                      <tr
                        key={plan.id}
                        onClick={() => {
                          setSelectedId(plan.id);
                        }}
                        className={`cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-accent/50 ${
                          plan.id === selectedId ? 'bg-accent/60' : ''
                        }`}
                      >
                        <td className="py-2.5 pr-3 font-medium">{plan.code}</td>
                        <td className="py-2.5 pr-3">{plan.name}</td>
                        <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                          {RATE_PLAN_KIND_LABELS[plan.kind]}
                        </td>
                        {/* F2: one rate per category, so the cell lists pairs
                            rather than a single plan-level number. */}
                        <td className="py-2.5 pr-3 text-xs">
                          {plan.roomTypes.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                              {plan.roomTypes.map((entry) => (
                                <span key={entry.roomTypeId} className="whitespace-nowrap">
                                  <span className="font-medium">{entry.code}</span>{' '}
                                  <span className="text-muted-foreground tabular-nums">
                                    {formatRate(
                                      entry.defaultRate.amountMinor,
                                      entry.defaultRate.currency,
                                    )}
                                  </span>
                                </span>
                              ))}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5">
                          <StatusBadge plan={plan} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <DetailPane
          plan={selected}
          canManage={canManage}
          busy={pending}
          onEdit={() => {
            setMode('edit');
            setNotice(null);
          }}
          onActivate={(plan) => {
            applyStatus('ACTIVATE', plan);
          }}
          onRequestConfirm={(request) => {
            setConfirming(request);
          }}
        />
      </div>

      {/* The date-wise calendar, inside this screen rather than beside it.
          A separate rates section would mean two places that disagree about
          which plans exist; this one reads from the same `plans` state the
          list above renders, so a plan created or repriced here is
          immediately selectable there.

          Only plans that can actually be priced are offered: active, not
          archived, and with at least one assignment. Offering a paused plan
          would be offering a read-only calendar with no explanation. */}
      <RateCalendar
        hotelId={hotelId}
        plans={pricingPlans}
        currency={currency}
        canManage={canManage}
        onPlanChanged={(saved) => {
          absorb(saved, `Default rate updated for ${saved.code}.`);
        }}
        onInspectRule={(ruleId) => {
          setInspectRuleId(ruleId);
        }}
        reloadKey={rulesVersion}
        selectedPlanId={pricingPlanId}
        onPlanSelected={(planId) => {
          setPricingPlanId(planId);
        }}
      />

      {/* Seasons and recurring rules, for the SAME plan the calendar is
          showing. Inside this screen rather than beside it, so there is one
          Rates & Inventory area rather than two that disagree. */}
      <PricingRulesPanel
        hotelId={hotelId}
        plan={pricingPlan}
        canManage={canManage}
        onRulesChanged={() => {
          setRulesVersion((previous) => previous + 1);
        }}
        focusRuleId={inspectRuleId}
        onFocusHandled={() => {
          setInspectRuleId(null);
        }}
      />

      {/* F4: extra-guest charges for the SAME plan the calendar and the rules
          panel are showing. `rulesVersion` is passed through because a changed
          base rate -- an F2 override or an F3 rule -- changes what a PERCENT
          extra-guest charge resolves to, so a stale preview would be wrong. */}
      <OccupancyPricingPanel
        hotelId={hotelId}
        plan={pricingPlan}
        canManage={canManage}
        reloadKey={rulesVersion}
        onConfigSaved={() => {
          // The base occupancy is shown on the plans list, so re-read it
          // rather than patching one field in two places.
          void reload({ status, kind, search });
          setRulesVersion((previous) => previous + 1);
        }}
      />

      {/* AV-07: minimum stay, closed to arrival and closed to departure, for
          the SAME plan the calendar and the other panels are showing. */}
      <RestrictionsPanel hotelId={hotelId} plan={pricingPlan} canManage={canManage} />

      {/* F5: promotions apply across rate plans rather than to one, so this
          panel takes the whole selectable set rather than the single plan the
          calendar and the rules panel are focused on. It owns its own reads;
          nothing above it needs to know when a promotion changes, because no
          other panel displays one. */}
      <PromotionsPanel
        hotelId={hotelId}
        plans={pricingPlans}
        currency={currency}
        canManage={canManage}
      />

      {confirming !== null ? (
        <ConfirmDialog
          request={confirming}
          busy={pending}
          onCancel={() => {
            setConfirming(null);
          }}
          onConfirm={() => {
            applyStatus(confirming.action, confirming.plan);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The limits of this scope, stated rather than left to be discovered.
 *
 * The first sentence is the important one: an operator who believes a rate
 * entered here is being quoted at the desk has been misled by the screen.
 */
function ScopeNotice() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="flex flex-col gap-1 text-xs">
        <p className="font-medium text-foreground">
          Bookings price from a plan when one is chosen in the booking form.
        </p>
        <p className="text-muted-foreground">
          Each night is priced from this plan&apos;s calendar — date price, then season, weekday and
          weekend rules, then the default — and taxed in its own GST band. Bookings made without a
          plan still use the room type&apos;s rack rate. A price is fixed when the booking is made;
          changing it here does not reprice existing bookings. Extra-guest charges, promotions and
          stay restrictions apply to bookings made on a plan. Nothing here reaches an OTA.
        </p>
      </div>
    </div>
  );
}

function StatusBadge({ plan }: { plan: RatePlanView }) {
  if (plan.archivedAt !== null) {
    return <Badge variant="outline">Archived</Badge>;
  }
  return plan.isActive ? (
    <Badge variant="default">Active</Badge>
  ) : (
    <Badge variant="secondary">Paused</Badge>
  );
}

function EmptyState({
  filtered,
  canManage,
  onCreate,
}: {
  filtered: boolean;
  canManage: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Tag className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">
        {filtered ? 'No rate plans match these filters' : 'No rate plans yet'}
      </p>
      <p className="max-w-sm text-xs text-muted-foreground">
        {filtered
          ? 'Try a different status or clear the search.'
          : 'A rate plan is a named price list — "BAR", "Corporate", "Staff" — applied to one or more room types.'}
      </p>
      {!filtered && canManage ? (
        <Button size="sm" onClick={onCreate}>
          <Plus className="size-4" aria-hidden />
          Create the first one
        </Button>
      ) : null}
    </div>
  );
}

function DetailPane({
  plan,
  canManage,
  busy,
  onEdit,
  onActivate,
  onRequestConfirm,
}: {
  plan: RatePlanView | null;
  canManage: boolean;
  busy: boolean;
  onEdit: () => void;
  onActivate: (plan: RatePlanView) => void;
  onRequestConfirm: (request: PendingAction) => void;
}) {
  if (plan === null) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-xs text-muted-foreground">
          Select a rate plan to see its configuration.
        </CardContent>
      </Card>
    );
  }

  // Narrowed once, so the archived branch below carries a non-null instant
  // rather than a `?? ''` fallback that would render "Invalid Date" if the
  // guard and the use ever drifted apart.
  const archivedAt = plan.archivedAt;
  const archived = archivedAt !== null;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-1">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span>{plan.name}</span>
          <StatusBadge plan={plan} />
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {plan.code} · {RATE_PLAN_KIND_LABELS[plan.kind]}
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {plan.description !== null && plan.description.length > 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{plan.description}</p>
        ) : null}

        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Created</dt>
            <dd className="tabular-nums">{formatInstant(plan.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last updated</dt>
            <dd className="tabular-nums">{formatInstant(plan.updatedAt)}</dd>
          </div>
          {archivedAt !== null ? (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Archived</dt>
              <dd className="tabular-nums">{formatInstant(archivedAt)}</dd>
            </div>
          ) : null}
        </dl>

        {/* F2: each category carries its own default, and its own count of
            nights priced away from it. Shown as a small table rather than a
            tag list, because three numbers per row is a table. */}
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">Room types and default rates</p>
          {plan.roomTypes.length === 0 ? (
            <p className="text-xs text-destructive">
              No room types assigned — this plan cannot be sold.
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sr-only">
                <tr>
                  <th scope="col">Room type</th>
                  <th scope="col">Default nightly rate</th>
                  <th scope="col">Dated prices</th>
                </tr>
              </thead>
              <tbody>
                {plan.roomTypes.map((entry) => (
                  <tr key={entry.roomTypeId} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-2">
                      <span className="font-medium">{entry.code}</span>{' '}
                      <span className="text-muted-foreground">{entry.name}</span>
                    </td>
                    <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">
                      {formatRate(entry.defaultRate.amountMinor, entry.defaultRate.currency)}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                      {entry.overrideCount === 0 ? '—' : `${entry.overrideCount} dated`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {canManage ? (
          archived ? (
            <p className="rounded-md border border-dashed border-border p-2.5 text-xs text-muted-foreground">
              Archived plans cannot be edited or reactivated. Create a new plan instead.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
                Edit
              </Button>
              {plan.isActive ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    onRequestConfirm({ action: 'DEACTIVATE', plan });
                  }}
                >
                  <CirclePause className="size-3.5" aria-hidden />
                  Pause
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    onActivate(plan);
                  }}
                >
                  <CirclePlay className="size-3.5" aria-hidden />
                  Activate
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  onRequestConfirm({ action: 'ARCHIVE', plan });
                }}
              >
                <Archive className="size-3.5" aria-hidden />
                Archive
              </Button>
            </div>
          )
        ) : (
          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            Changing rate plans needs the manage-rates permission.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Confirmation for the two actions that are not trivially reversible.
 *
 * Activate is not confirmed: it is the safe direction and undoing it is one
 * click. Archive is confirmed emphatically because it is terminal — there is
 * no unarchive, which the copy states rather than implies.
 */
function ConfirmDialog({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: PendingAction;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const terminal = request.action === 'ARCHIVE';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rate-plan-confirm-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <h2 id="rate-plan-confirm-title" className="text-base font-semibold">
          {terminal ? 'Archive this rate plan?' : 'Pause this rate plan?'}
        </h2>

        <p className="mt-2 text-sm text-muted-foreground">
          {terminal ? (
            <>
              <span className="font-medium text-foreground">
                “{request.plan.name}” ({request.plan.code})
              </span>{' '}
              will be archived. This cannot be undone — there is no way to bring an archived plan
              back, and it cannot be edited afterwards. Pause it instead if you may want it again.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">
                “{request.plan.name}” ({request.plan.code})
              </span>{' '}
              will stop being offered. Nothing is lost and you can activate it again at any time.
            </>
          )}
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={terminal ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {terminal ? 'Archive permanently' : 'Pause'}
          </Button>
        </div>
      </div>
    </div>
  );
}
