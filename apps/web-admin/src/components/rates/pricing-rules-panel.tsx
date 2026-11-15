'use client';

/**
 * Seasons and recurring weekday/weekend rules, for one rate plan (F3).
 *
 * ===========================================================================
 * ONE PANEL, TWO TABS, because the two route families are two operator
 * intents — "Christmas" and "Saturdays are dearer" — over one resource type.
 * A single flat list would mix a dated season with a recurring rule and make
 * the precedence between them invisible, which is the one thing an operator
 * most needs to understand here.
 *
 * PRECEDENCE IS STATED ON SCREEN, not left to be inferred. An operator who
 * cannot see that a date override beats a season, and a season beats a weekend
 * rule, will set a price and then believe the system is broken when a
 * different number appears on the calendar.
 *
 * CONFLICTS COME FROM THE SERVER. The ambiguity rule — same kind, same
 * priority, overlapping match, shared room type — is checked server-side at
 * write time, and its refusal arrives as a field-keyed 400 whose message names
 * the colliding rule and says how to resolve it. This component renders that
 * message; it does not re-implement the check, because a second copy would be
 * a second answer.
 *
 * NO PRICES ARE COMPUTED HERE. A rule's own amounts are shown, but what a
 * given night costs is the calendar's business and comes from the API.
 * ===========================================================================
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  AlertTriangle,
  CalendarRange,
  Check,
  Loader2,
  Pencil,
  Plus,
  Repeat,
  ToggleLeft,
  ToggleRight,
  Trash2,
  X,
} from 'lucide-react';

import {
  DAY_OF_WEEK_LABELS,
  DAY_OF_WEEK_SHORT,
  RATE_PRICING_RULE_KIND_LABELS,
  type CreateRatePricingRuleRequest,
  type RatePlanView,
  type RatePricingRuleKind,
  type RatePricingRuleView,
  type UpdateRatePricingRuleRequest,
} from '@repo/types';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';

import { ApiRequestError } from '@/lib/api';
import {
  createPricingRule,
  deletePricingRule,
  fetchPricingRules,
  setPricingRuleStatus,
  updatePricingRule,
  type PricingRuleFamily,
} from '@/lib/properties-client';

const DAYS = [0, 1, 2, 3, 4, 5, 6];

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

/** Minor units to the string a number input shows. */
function toMajorInput(amountMinor: number): string {
  const major = amountMinor / 100;
  return Number.isInteger(major) ? String(major) : major.toFixed(2);
}

/** What a rule matches, in one readable phrase. */
function describeMatch(rule: RatePricingRuleView, weekendDays: readonly number[]): string {
  if (rule.kind === 'SEASONAL') {
    return `${rule.startDate ?? '?'} → ${rule.endDate ?? '?'} (inclusive)`;
  }
  if (rule.kind === 'WEEKDAY') {
    return rule.daysOfWeek.map((day) => DAY_OF_WEEK_SHORT[day] ?? String(day)).join(', ');
  }
  return weekendDays.length === 0
    ? 'this property has no weekend configured — matches nothing'
    : weekendDays.map((day) => DAY_OF_WEEK_SHORT[day] ?? String(day)).join(', ');
}

type Draft = {
  kind: RatePricingRuleKind;
  name: string;
  startDate: string;
  endDate: string;
  daysOfWeek: number[];
  priority: string;
  /** roomTypeId → major-unit string. Only ticked rows are sent. */
  prices: Record<string, { selected: boolean; amount: string }>;
};

interface Props {
  hotelId: string;
  plan: RatePlanView | null;
  canManage: boolean;
  /** Jump to the calendar for one room type, after a rule changes. */
  onRulesChanged: () => void;
  /** Set by the calendar when an operator asks to inspect a date's rule. */
  focusRuleId: string | null;
  onFocusHandled: () => void;
}

export function PricingRulesPanel({
  hotelId,
  plan,
  canManage,
  onRulesChanged,
  focusRuleId,
  onFocusHandled,
}: Props) {
  const [family, setFamily] = useState<PricingRuleFamily>('seasons');
  const [rules, setRules] = useState<RatePricingRuleView[]>([]);
  const [weekendDays, setWeekendDays] = useState<number[]>([]);
  const [isEditable, setIsEditable] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<RatePricingRuleView | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RatePricingRuleView | null>(null);
  const [pending, startTransition] = useTransition();

  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (nextFamily: PricingRuleFamily, planId: string) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setLoading(true);
      setError(null);
      try {
        const response = await fetchPricingRules(
          hotelId,
          planId,
          nextFamily,
          {},
          { signal: controller.signal },
        );
        setRules(response.items);
        setWeekendDays(response.weekendDays);
        setIsEditable(response.isEditable);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setRules([]);
        setError(firstMessage(cause, 'The pricing rules could not be loaded.'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [hotelId],
  );

  // Timer-driven for the same reason the calendar's read is: it keeps
  // `setLoading` out of the effect's synchronous body, and a fast tab switch
  // collapses into one request.
  useEffect(() => {
    if (plan === null) return;
    const planId = plan.id;

    const timer = setTimeout(() => {
      void load(family, planId);
    }, 120);

    return () => {
      clearTimeout(timer);
    };
  }, [family, plan, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  /**
   * The calendar asked to inspect a particular rule.
   *
   * ===========================================================================
   * The rule may belong to the other tab — a date can be priced by a season or
   * by a weekday rule — so when it is not in the loaded list the tab is
   * switched and this runs again once the other list arrives.
   *
   * `attempted` is what stops that becoming a loop. A rule id that is in
   * NEITHER list (deleted in another window, say) would otherwise flip the tab
   * back and forth forever, re-fetching each time. Each family is tried at
   * most once per focus request, and then the request is dropped with a
   * message rather than retried.
   *
   * Deferred through a timer for the same reason the loads are: it keeps the
   * `setState` calls out of the effect's synchronous body, which is what the
   * cascading-render rule is about.
   * ===========================================================================
   */
  const attempted = useRef<{ ruleId: string; families: Set<PricingRuleFamily> } | null>(null);

  useEffect(() => {
    if (focusRuleId === null) {
      attempted.current = null;
      return;
    }

    const timer = setTimeout(() => {
      const here = rules.find((rule) => rule.id === focusRuleId);
      if (here !== undefined) {
        setEditing(here);
        setCreating(false);
        onFocusHandled();
        attempted.current = null;
        return;
      }

      // Record this family as tried, resetting when the request is for a
      // different rule than the one being tracked.
      const tracker =
        attempted.current?.ruleId === focusRuleId
          ? attempted.current
          : { ruleId: focusRuleId, families: new Set<PricingRuleFamily>() };
      tracker.families.add(family);
      attempted.current = tracker;

      const other: PricingRuleFamily = family === 'seasons' ? 'pricing-rules' : 'seasons';
      if (!tracker.families.has(other)) {
        setFamily(other);
        return;
      }

      // Neither list has it. Give up rather than ping-pong.
      onFocusHandled();
      attempted.current = null;
      setNotice('That rule no longer exists — it may have been deleted elsewhere.');
    }, 60);

    return () => {
      clearTimeout(timer);
    };
  }, [focusRuleId, rules, family, onFocusHandled]);

  function absorb(saved: RatePricingRuleView, message: string): void {
    setRules((previous) => {
      const index = previous.findIndex((rule) => rule.id === saved.id);
      if (index === -1) return [saved, ...previous];
      const next = [...previous];
      next[index] = saved;
      return next;
    });
    setNotice(message);
    setEditing(null);
    setCreating(false);
    // The calendar's effective prices just moved for every matching night.
    onRulesChanged();
  }

  function toggleStatus(rule: RatePricingRuleView): void {
    setError(null);
    setNotice(null);
    startTransition(() => {
      void (async () => {
        try {
          const saved = await setPricingRuleStatus(
            hotelId,
            rule.ratePlanId,
            family,
            rule.id,
            rule.isEnabled ? 'DISABLE' : 'ENABLE',
          );
          absorb(saved, `"${saved.name}" ${saved.isEnabled ? 'enabled' : 'disabled'}.`);
        } catch (cause) {
          // Enabling can legitimately fail: it re-runs the conflict check.
          setError(firstMessage(cause, 'That rule could not be changed.'));
        }
      })();
    });
  }

  function remove(rule: RatePricingRuleView): void {
    setError(null);
    setNotice(null);
    startTransition(() => {
      void (async () => {
        try {
          await deletePricingRule(hotelId, rule.ratePlanId, family, rule.id);
          setRules((previous) => previous.filter((entry) => entry.id !== rule.id));
          setNotice(`"${rule.name}" deleted. Dated price overrides were not affected.`);
          onRulesChanged();
        } catch (cause) {
          setError(firstMessage(cause, 'That rule could not be deleted.'));
        } finally {
          setConfirmDelete(null);
        }
      })();
    });
  }

  if (plan === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Seasonal and recurring pricing</CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-xs text-muted-foreground">
          Select a rate plan to manage its seasons and weekday rules.
        </CardContent>
      </Card>
    );
  }

  const busy = pending || loading;
  const writable = canManage && isEditable;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {family === 'seasons' ? (
            <CalendarRange className="size-4 text-muted-foreground" aria-hidden />
          ) : (
            <Repeat className="size-4 text-muted-foreground" aria-hidden />
          )}
          Seasonal and recurring pricing
          <span className="text-xs font-normal text-muted-foreground">
            {plan.code} — {plan.name}
          </span>
        </CardTitle>

        <PrecedenceNote />
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-md border border-input p-0.5">
            {(
              [
                { value: 'seasons' as const, label: 'Seasons' },
                { value: 'pricing-rules' as const, label: 'Weekday & weekend' },
              ] satisfies { value: PricingRuleFamily; label: string }[]
            ).map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => {
                  setFamily(tab.value);
                  setEditing(null);
                  setCreating(false);
                  setNotice(null);
                }}
                aria-pressed={family === tab.value}
                disabled={busy}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  family === tab.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {loading ? (
              <Loader2
                className="size-3.5 animate-spin text-muted-foreground"
                aria-label="Loading"
              />
            ) : null}
            {writable ? (
              <Button
                size="sm"
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                  setNotice(null);
                }}
                disabled={busy}
              >
                <Plus className="size-4" aria-hidden />
                {family === 'seasons' ? 'New season' : 'New rule'}
              </Button>
            ) : null}
          </div>
        </div>

        {!isEditable ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            This plan is paused or archived, so its pricing rules are read-only.
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

        {creating || editing !== null ? (
          <RuleForm
            hotelId={hotelId}
            plan={plan}
            family={family}
            rule={editing}
            weekendDays={weekendDays}
            onSaved={(saved) => {
              absorb(
                saved,
                editing === null ? `"${saved.name}" created.` : `"${saved.name}" saved.`,
              );
            }}
            onCancel={() => {
              setEditing(null);
              setCreating(false);
            }}
          />
        ) : null}

        {rules.length === 0 && !loading ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {family === 'seasons'
              ? 'No seasons yet. A season prices a named date range — "Christmas", "Monsoon" — above the default.'
              : 'No recurring rules yet. A weekday rule prices named days; a weekend rule uses this property’s configured weekend.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className={`rounded-md border p-3 ${
                  rule.isEnabled ? 'border-border' : 'border-dashed border-border opacity-70'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{rule.name}</span>
                      <Badge variant="outline">{RATE_PRICING_RULE_KIND_LABELS[rule.kind]}</Badge>
                      {rule.isEnabled ? (
                        <Badge variant="default">Enabled</Badge>
                      ) : (
                        <Badge variant="secondary">Disabled</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        priority {rule.priority}
                      </span>
                    </div>

                    <p className="text-xs text-muted-foreground tabular-nums">
                      {describeMatch(rule, weekendDays)}
                    </p>

                    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                      {rule.prices.map((price) => (
                        <li key={price.roomTypeId} className="whitespace-nowrap">
                          <span className="font-medium">{price.code}</span>{' '}
                          <span className="text-muted-foreground tabular-nums">
                            {formatMoney(price.amountMinor, rule.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {writable ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(rule);
                          setCreating(false);
                          setNotice(null);
                        }}
                        disabled={busy}
                        aria-label={`Edit ${rule.name}`}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          toggleStatus(rule);
                        }}
                        disabled={busy}
                        aria-label={`${rule.isEnabled ? 'Disable' : 'Enable'} ${rule.name}`}
                      >
                        {rule.isEnabled ? (
                          <ToggleRight className="size-4" aria-hidden />
                        ) : (
                          <ToggleLeft className="size-4" aria-hidden />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirmDelete(rule);
                        }}
                        disabled={busy}
                        aria-label={`Delete ${rule.name}`}
                      >
                        <Trash2 className="size-3.5 text-destructive" aria-hidden />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {confirmDelete !== null ? (
        <ConfirmDelete
          rule={confirmDelete}
          busy={pending}
          onCancel={() => {
            setConfirmDelete(null);
          }}
          onConfirm={() => {
            remove(confirmDelete);
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * The precedence ladder, on screen.
 *
 * An operator who cannot see that a date override outranks a season will set a
 * seasonal price, see a different number on the calendar, and conclude the
 * system is broken. Four lines here prevent that conversation.
 */
function PrecedenceNote() {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      Highest wins: <span className="font-medium text-foreground">a dated price you typed</span> → a
      season → a weekday rule → a weekend rule → the room type&apos;s default. Within one kind, the
      higher priority wins; two rules of the same kind at the same priority covering the same room
      type are refused.
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create / edit                                                             */
/* -------------------------------------------------------------------------- */

function RuleForm({
  hotelId,
  plan,
  family,
  rule,
  weekendDays,
  onSaved,
  onCancel,
}: {
  hotelId: string;
  plan: RatePlanView;
  family: PricingRuleFamily;
  rule: RatePricingRuleView | null;
  weekendDays: readonly number[];
  onSaved: (saved: RatePricingRuleView) => void;
  onCancel: () => void;
}) {
  const editing = rule !== null;

  const [draft, setDraft] = useState<Draft>(() => ({
    kind: rule?.kind ?? (family === 'seasons' ? 'SEASONAL' : 'WEEKDAY'),
    name: rule?.name ?? '',
    startDate: rule?.startDate ?? '',
    endDate: rule?.endDate ?? '',
    daysOfWeek: rule === null ? [] : [...rule.daysOfWeek],
    priority: String(rule?.priority ?? 0),
    prices: Object.fromEntries(
      plan.roomTypes.map((assignment) => {
        const existing = rule?.prices.find((price) => price.roomTypeId === assignment.roomTypeId);
        return [
          assignment.roomTypeId,
          {
            selected: existing !== undefined,
            // Seeded from the assignment's own default, which is the most
            // useful starting number an operator can be offered.
            amount: toMajorInput(existing?.amountMinor ?? assignment.defaultRate.amountMinor),
          },
        ];
      }),
    ),
  }));

  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = plan.roomTypes.filter(
    (assignment) => draft.prices[assignment.roomTypeId]?.selected === true,
  );

  function submit(): void {
    setIssues({});
    setFormError(null);

    if (chosen.length === 0) {
      setIssues({ prices: 'Price at least one room type.' });
      return;
    }

    const prices: { roomTypeId: string; amountMinor: number }[] = [];
    for (const assignment of chosen) {
      const entry = draft.prices[assignment.roomTypeId];
      if (entry === undefined) continue;
      const major = Number(entry.amount);
      if (entry.amount.trim().length === 0 || !Number.isFinite(major)) {
        setIssues({
          [`price.${assignment.roomTypeId}`]: `Enter a rate for ${assignment.code}.`,
        });
        return;
      }
      // Major to minor, once, at the boundary. Rounded, not truncated.
      prices.push({ roomTypeId: assignment.roomTypeId, amountMinor: Math.round(major * 100) });
    }

    startTransition(() => {
      void (async () => {
        try {
          const saved = editing
            ? await updatePricingRule(hotelId, plan.id, family, rule.id, {
                name: draft.name,
                priority: Number(draft.priority),
                ...(draft.kind === 'SEASONAL'
                  ? {
                      startDate: draft.startDate as UpdateRatePricingRuleRequest['startDate'],
                      endDate: draft.endDate as UpdateRatePricingRuleRequest['endDate'],
                    }
                  : {}),
                ...(draft.kind === 'WEEKDAY' ? { daysOfWeek: draft.daysOfWeek } : {}),
                prices,
              } satisfies UpdateRatePricingRuleRequest)
            : await createPricingRule(hotelId, plan.id, family, {
                kind: draft.kind,
                name: draft.name,
                priority: Number(draft.priority),
                ...(draft.kind === 'SEASONAL'
                  ? {
                      startDate: draft.startDate as CreateRatePricingRuleRequest['startDate'],
                      endDate: draft.endDate as CreateRatePricingRuleRequest['endDate'],
                    }
                  : {}),
                daysOfWeek: draft.kind === 'WEEKDAY' ? draft.daysOfWeek : [],
                prices,
              } satisfies CreateRatePricingRuleRequest);

          onSaved(saved);
        } catch (cause) {
          const fieldIssues = issuesFrom(cause);
          if (Object.keys(fieldIssues).length > 0) {
            setIssues(fieldIssues);
            return;
          }
          setFormError(firstMessage(cause, 'That rule could not be saved.'));
        }
      })();
    });
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-md border border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {editing
            ? `Edit ${RATE_PRICING_RULE_KIND_LABELS[draft.kind].toLowerCase()}`
            : family === 'seasons'
              ? 'New season'
              : 'New recurring rule'}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onCancel}
          disabled={pending}
          aria-label="Close the form"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {/* Kind is only choosable on the recurring tab, and only when creating:
          turning a weekday rule into a weekend rule is a different rule. */}
      {family === 'pricing-rules' && !editing ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Rule type</span>
          <div className="inline-flex w-fit rounded-md border border-input p-0.5">
            {(['WEEKDAY', 'WEEKEND'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  setDraft((previous) => ({ ...previous, kind }));
                }}
                aria-pressed={draft.kind === kind}
                disabled={pending}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  draft.kind === kind
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {RATE_PRICING_RULE_KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {draft.kind === 'WEEKDAY'
              ? 'You choose the days. Outranks a weekend rule on any day both cover.'
              : weekendDays.length === 0
                ? 'Uses this property’s weekend — which is currently unset, so this rule would match nothing. Set it in property settings first.'
                : `Uses this property’s weekend: ${weekendDays
                    .map((day) => DAY_OF_WEEK_LABELS[day] ?? String(day))
                    .join(', ')}.`}
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-muted-foreground">Name</span>
          <input
            value={draft.name}
            onChange={(event) => {
              setDraft((previous) => ({ ...previous, name: event.target.value }));
            }}
            disabled={pending}
            maxLength={120}
            autoComplete="off"
            placeholder={draft.kind === 'SEASONAL' ? 'Christmas 2026' : 'Weekend uplift'}
            className={inputClass(issues['name'] !== undefined)}
          />
          {issues['name'] !== undefined ? (
            <span className="text-destructive" role="alert">
              {issues['name']}
            </span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium text-muted-foreground">Priority</span>
          <input
            type="number"
            min={0}
            max={1000}
            step={1}
            value={draft.priority}
            onChange={(event) => {
              setDraft((previous) => ({ ...previous, priority: event.target.value }));
            }}
            disabled={pending}
            className={`${inputClass(issues['priority'] !== undefined)} max-w-28 tabular-nums`}
          />
          <span className="text-muted-foreground">
            Higher wins against another rule of the same kind.
          </span>
        </label>
      </div>

      {/* Conflicts arrive keyed on `priority`, because raising it is the
          remedy. Shown full-width, not squeezed under the number input. */}
      {issues['priority'] !== undefined ? (
        <p
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {issues['priority']}
        </p>
      ) : null}

      {draft.kind === 'SEASONAL' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-muted-foreground">First night</span>
            <input
              type="date"
              value={draft.startDate}
              onChange={(event) => {
                setDraft((previous) => ({ ...previous, startDate: event.target.value }));
              }}
              disabled={pending}
              className={`${inputClass(issues['startDate'] !== undefined)} tabular-nums`}
            />
            {issues['startDate'] !== undefined ? (
              <span className="text-destructive" role="alert">
                {issues['startDate']}
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-muted-foreground">Last night (inclusive)</span>
            <input
              type="date"
              value={draft.endDate}
              onChange={(event) => {
                setDraft((previous) => ({ ...previous, endDate: event.target.value }));
              }}
              disabled={pending}
              className={`${inputClass(issues['endDate'] !== undefined)} tabular-nums`}
            />
            {issues['endDate'] !== undefined ? (
              <span className="text-destructive" role="alert">
                {issues['endDate']}
              </span>
            ) : (
              <span className="text-muted-foreground">
                Both ends are included. A season may cross New Year.
              </span>
            )}
          </label>
        </div>
      ) : null}

      {draft.kind === 'WEEKDAY' ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-muted-foreground">Days</legend>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((day) => {
              const on = draft.daysOfWeek.includes(day);
              return (
                <label
                  key={day}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    on
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-input bg-background text-muted-foreground hover:bg-accent'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      setDraft((previous) => ({
                        ...previous,
                        daysOfWeek: on
                          ? previous.daysOfWeek.filter((value) => value !== day)
                          : [...previous.daysOfWeek, day].sort((a, b) => a - b),
                      }));
                    }}
                    disabled={pending}
                    className="size-3.5 accent-primary"
                  />
                  {DAY_OF_WEEK_SHORT[day]}
                </label>
              );
            })}
          </div>
          {issues['daysOfWeek'] !== undefined ? (
            <p className="text-xs text-destructive" role="alert">
              {issues['daysOfWeek']}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {/* -- Per-room-type prices ---------------------------------------- */}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-xs font-medium text-muted-foreground">
          Rates for this rule ({plan.currency})
        </legend>

        <div className="overflow-x-auto rounded-md border border-border bg-background">
          <table className="w-full min-w-[26rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <th scope="col" className="w-10 px-3 py-2 font-medium">
                  <span className="sr-only">Included</span>
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Room type
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Default
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  This rule
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.roomTypes.map((assignment) => {
                const entry = draft.prices[assignment.roomTypeId];
                if (entry === undefined) return null;
                const priceError = issues[`price.${assignment.roomTypeId}`];

                return (
                  <tr
                    key={assignment.roomTypeId}
                    className={`border-b border-border/60 last:border-0 ${
                      entry.selected ? '' : 'opacity-60'
                    }`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={entry.selected}
                        onChange={(event) => {
                          setDraft((previous) => ({
                            ...previous,
                            prices: {
                              ...previous.prices,
                              [assignment.roomTypeId]: {
                                ...entry,
                                selected: event.target.checked,
                              },
                            },
                          }));
                        }}
                        disabled={pending}
                        aria-label={`Price ${assignment.code} under this rule`}
                        className="size-4 accent-primary"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-medium">{assignment.code}</span>{' '}
                      <span className="text-xs text-muted-foreground">{assignment.name}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
                      {formatMoney(assignment.defaultRate.amountMinor, plan.currency)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={entry.amount}
                        onChange={(event) => {
                          setDraft((previous) => ({
                            ...previous,
                            prices: {
                              ...previous.prices,
                              [assignment.roomTypeId]: {
                                ...entry,
                                amount: event.target.value,
                              },
                            },
                          }));
                        }}
                        disabled={pending || !entry.selected}
                        aria-label={`Rate for ${assignment.code} under this rule`}
                        className={`${inputClass(priceError !== undefined)} max-w-32 text-right tabular-nums`}
                      />
                      {priceError !== undefined ? (
                        <p className="mt-1 text-xs text-destructive" role="alert">
                          {priceError}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {issues['prices'] !== undefined ? (
          <p className="text-xs text-destructive" role="alert">
            {issues['prices']}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Only ticked categories are priced by this rule. The rest keep whatever applies to them.
          </p>
        )}
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
        <Button type="submit" disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Create'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ConfirmDelete({
  rule,
  busy,
  onCancel,
  onConfirm,
}: {
  rule: RatePricingRuleView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-rule-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <h2 id="delete-rule-title" className="text-base font-semibold">
          Delete &ldquo;{rule.name}&rdquo;?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Nights this rule priced will fall back to whatever applies beneath it — another rule, or
          the room type&apos;s default. This cannot be undone.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Dated prices you typed into the calendar are <strong>not</strong> affected.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            Delete
          </Button>
        </div>
      </div>
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
