'use client';

/**
 * Promotions, promo codes and the discount preview (F5).
 *
 * ===========================================================================
 * NOTHING IS PRICED HERE. Every figure — each night's base rate, its source,
 * the extra-person charges, the discount and the totals — comes from the
 * server's preview endpoint, which calls the same F2/F3 resolver as the
 * calendar, the same F4 occupancy calculator, and then F5's eligibility and
 * discount functions. A client that computed any of that would be guessing at
 * four layers of precedence it cannot see.
 *
 * PREVIEWING IS READ-ONLY and the copy says so: no redemption is consumed, no
 * counter moves, nothing is booked. The scope is emphatic about this and so is
 * the UI, because an operator who believes a preview reserved their code will
 * stop previewing.
 *
 * EVERY PRICE SHOWN IS PRE-TAX, labelled wherever a total appears. Tax is
 * applied downstream at folio posting and F5 computes none of it.
 *
 * PRECEDENCE AND THE NO-STACKING RULE ARE STATED ON SCREEN. An operator who
 * cannot see that only one promotion applies will configure two and then
 * report the second as broken.
 * ===========================================================================
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  AlertTriangle,
  BadgePercent,
  Check,
  Loader2,
  Pencil,
  Plus,
  Tag,
  ToggleLeft,
  ToggleRight,
  Trash2,
  X,
} from 'lucide-react';

import {
  PROMOTION_DISCOUNT_KIND_LABELS,
  type CreatePromotionRequest,
  type PromoCodeView,
  type PromotionDiscountKind,
  type PromotionPreview,
  type PromotionView,
  type RatePlanView,
  type UpdatePromotionRequest,
} from '@repo/types';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';

import { ApiRequestError } from '@/lib/api';
import {
  createPromoCode,
  createPromotion,
  deletePromoCode,
  deletePromotion,
  fetchPromoCodes,
  fetchPromotions,
  previewPromotion,
  setPromoCodeStatus,
  setPromotionStatus,
  updatePromotion,
} from '@/lib/properties-client';

const KINDS: PromotionDiscountKind[] = ['PERCENT', 'FIXED_PER_NIGHT'];

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

function todayLocal(): string {
  // en-CA formats as YYYY-MM-DD, matching `currentDateInTimeZone`.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** `YYYY-MM-DD` shifted by whole days, anchored at UTC noon. */
function shiftDate(date: string, days: number): string {
  const anchor = new Date(`${date}T12:00:00.000Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/** The discount, as a short readable phrase. */
function describeDiscount(promotion: PromotionView): string {
  return promotion.discount.kind === 'PERCENT'
    ? `${String(promotion.discount.value / 100)}% off`
    : `${formatMoney(promotion.discount.value, promotion.currency)} off per night`;
}

function describeWindow(from: string | null, through: string | null): string {
  if (from === null && through === null) return 'any dates';
  if (from === null) return `until ${through ?? ''}`;
  if (through === null) return `from ${from}`;
  return `${from} → ${through}`;
}

interface Props {
  hotelId: string;
  /** Plans the operator may attach a promotion to, and their room types. */
  plans: RatePlanView[];
  currency: string;
  canManage: boolean;
}

export function PromotionsPanel({ hotelId, plans, currency, canManage }: Props) {
  const [promotions, setPromotions] = useState<PromotionView[]>([]);
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState<PromotionView | null>(null);
  const [creating, setCreating] = useState(false);
  const [codesFor, setCodesFor] = useState<PromotionView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PromotionView | null>(null);
  const [pending, startTransition] = useTransition();

  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(
    async (nextStatus: 'all' | 'active' | 'inactive') => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setLoading(true);
      setError(null);
      try {
        const response = await fetchPromotions(
          hotelId,
          { status: nextStatus },
          { signal: controller.signal },
        );
        setPromotions(response.items);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPromotions([]);
        setError(firstMessage(cause, 'The promotions could not be loaded.'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [hotelId],
  );

  // Timer-driven, like the sibling panels: it keeps `setLoading` out of the
  // effect's synchronous body and collapses a fast filter change into one read.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(status);
    }, 120);
    return () => {
      clearTimeout(timer);
    };
  }, [status, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  function absorb(saved: PromotionView, message: string): void {
    setPromotions((previous) => {
      const index = previous.findIndex((entry) => entry.id === saved.id);
      if (index === -1) return [saved, ...previous];
      const next = [...previous];
      next[index] = saved;
      return next;
    });
    setNotice(message);
    setEditing(null);
    setCreating(false);
  }

  function toggleStatus(promotion: PromotionView): void {
    setError(null);
    setNotice(null);
    startTransition(() => {
      void (async () => {
        try {
          const saved = await setPromotionStatus(
            hotelId,
            promotion.id,
            promotion.isActive ? 'DEACTIVATE' : 'ACTIVATE',
          );
          absorb(saved, `"${saved.name}" ${saved.isActive ? 'activated' : 'deactivated'}.`);
        } catch (cause) {
          // Activating can legitimately fail: it re-runs the conflict check.
          setError(firstMessage(cause, 'That promotion could not be changed.'));
        }
      })();
    });
  }

  function remove(promotion: PromotionView): void {
    setError(null);
    setNotice(null);
    startTransition(() => {
      void (async () => {
        try {
          await deletePromotion(hotelId, promotion.id);
          setPromotions((previous) => previous.filter((entry) => entry.id !== promotion.id));
          setNotice(`"${promotion.name}" deleted.`);
        } catch (cause) {
          setError(firstMessage(cause, 'That promotion could not be deleted.'));
        } finally {
          setConfirmDelete(null);
        }
      })();
    });
  }

  const busy = pending || loading;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgePercent className="size-4 text-muted-foreground" aria-hidden />
          Promotions &amp; discounts
        </CardTitle>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Applied <span className="font-medium text-foreground">after</span> the base rate and
          extra-person charges.{' '}
          <span className="font-medium text-foreground">Promotions do not stack</span> — at most one
          applies to a night, the highest priority wins, and two that tie on priority over the same
          dates, plans and room types are refused. All amounts are pre-tax.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-md border border-input p-0.5">
            {[
              { value: 'all' as const, label: 'All' },
              { value: 'active' as const, label: 'Active' },
              { value: 'inactive' as const, label: 'Inactive' },
            ].map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => {
                  setStatus(tab.value);
                  setNotice(null);
                }}
                aria-pressed={status === tab.value}
                disabled={busy}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  status === tab.value
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
            {canManage ? (
              <Button
                size="sm"
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                  setNotice(null);
                }}
                disabled={busy || plans.length === 0}
              >
                <Plus className="size-4" aria-hidden />
                New promotion
              </Button>
            ) : null}
          </div>
        </div>

        {plans.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            A promotion applies to rate plans and room types, so create an active rate plan with at
            least one room type first.
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
          <PromotionForm
            hotelId={hotelId}
            plans={plans}
            currency={currency}
            promotion={editing}
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

        {promotions.length === 0 && !loading ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No promotions yet. A promotion discounts an eligible stay — a percentage, or a fixed
            amount off each night.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {promotions.map((promotion) => (
              <li
                key={promotion.id}
                className={`rounded-md border p-3 ${
                  promotion.isActive ? 'border-border' : 'border-dashed border-border opacity-70'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{promotion.name}</span>
                      <Badge variant="outline">{describeDiscount(promotion)}</Badge>
                      {promotion.isActive ? (
                        <Badge variant="default">Active</Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                      {promotion.requiresCode ? (
                        <Badge variant="outline">
                          <Tag className="mr-1 inline size-3" aria-hidden />
                          code required
                        </Badge>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        priority {promotion.priority}
                      </span>
                    </div>

                    <p className="text-xs text-muted-foreground tabular-nums">
                      Stays {describeWindow(promotion.stayFromDate, promotion.stayThroughDate)} ·
                      booked {describeWindow(promotion.bookFromDate, promotion.bookThroughDate)}
                      {promotion.minNights === null
                        ? ''
                        : ` · min ${String(promotion.minNights)} night(s)`}
                      {promotion.maxNights === null
                        ? ''
                        : ` · max ${String(promotion.maxNights)} night(s)`}
                      {promotion.minEligibleAmountMinor === null
                        ? ''
                        : ` · min spend ${formatMoney(
                            promotion.minEligibleAmountMinor,
                            promotion.currency,
                          )}`}
                    </p>

                    <p className="text-xs text-muted-foreground">
                      {promotion.appliesToAllRatePlans
                        ? 'All rate plans'
                        : `Plans: ${promotion.ratePlans.map((entry) => entry.code).join(', ')}`}
                      {' · '}
                      {promotion.appliesToAllRoomTypes
                        ? 'all room types'
                        : `rooms: ${promotion.roomTypes.map((entry) => entry.code).join(', ')}`}
                    </p>

                    <p className="text-xs text-muted-foreground">
                      {promotion.maxRedemptions === null
                        ? 'Unlimited redemptions'
                        : `${String(promotion.redeemedCount)} of ${String(
                            promotion.maxRedemptions,
                          )} used — ${String(promotion.remainingRedemptions ?? 0)} remaining`}
                      {promotion.codeCount > 0 ? ` · ${String(promotion.codeCount)} code(s)` : ''}
                    </p>
                  </div>

                  {canManage ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCodesFor(promotion);
                        }}
                        disabled={busy}
                      >
                        <Tag className="size-3.5" aria-hidden />
                        Codes
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(promotion);
                          setCreating(false);
                          setNotice(null);
                        }}
                        disabled={busy}
                        aria-label={`Edit ${promotion.name}`}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          toggleStatus(promotion);
                        }}
                        disabled={busy}
                        aria-label={`${promotion.isActive ? 'Deactivate' : 'Activate'} ${promotion.name}`}
                      >
                        {promotion.isActive ? (
                          <ToggleRight className="size-4" aria-hidden />
                        ) : (
                          <ToggleLeft className="size-4" aria-hidden />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setConfirmDelete(promotion);
                        }}
                        disabled={busy}
                        aria-label={`Delete ${promotion.name}`}
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

        {/* -- Preview ------------------------------------------------------ */}
        <PromotionPreviewPanel hotelId={hotelId} plans={plans} currency={currency} />
      </CardContent>

      {codesFor !== null ? (
        <CodesDialog
          hotelId={hotelId}
          promotion={codesFor}
          canManage={canManage}
          onClose={() => {
            setCodesFor(null);
            // The code count and `requiresCode` are on the promotion row.
            void load(status);
          }}
        />
      ) : null}

      {confirmDelete !== null ? (
        <ConfirmDialog
          title={`Delete "${confirmDelete.name}"?`}
          body="Stays already quoted with this promotion keep whatever was charged. The server refuses the delete if the promotion has ever been redeemed — deactivate it instead."
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

/* -------------------------------------------------------------------------- */
/*  Create / edit                                                             */
/* -------------------------------------------------------------------------- */

interface Draft {
  name: string;
  description: string;
  kind: PromotionDiscountKind;
  value: string;
  priority: string;
  stayFromDate: string;
  stayThroughDate: string;
  bookFromDate: string;
  bookThroughDate: string;
  minNights: string;
  maxNights: string;
  minSpend: string;
  allPlans: boolean;
  planIds: string[];
  allRooms: boolean;
  roomIds: string[];
  maxRedemptions: string;
}

/** Minor units or basis points to the string its input shows. Both /100. */
function toInput(value: number): string {
  const scaled = value / 100;
  return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(2);
}

function PromotionForm({
  hotelId,
  plans,
  currency,
  promotion,
  onSaved,
  onCancel,
}: {
  hotelId: string;
  plans: RatePlanView[];
  currency: string;
  promotion: PromotionView | null;
  onSaved: (saved: PromotionView) => void;
  onCancel: () => void;
}) {
  const editing = promotion !== null;

  const [draft, setDraft] = useState<Draft>(() => ({
    name: promotion?.name ?? '',
    description: promotion?.description ?? '',
    kind: promotion?.discount.kind ?? 'PERCENT',
    value: promotion === null ? '10' : toInput(promotion.discount.value),
    priority: String(promotion?.priority ?? 0),
    stayFromDate: promotion?.stayFromDate ?? '',
    stayThroughDate: promotion?.stayThroughDate ?? '',
    bookFromDate: promotion?.bookFromDate ?? '',
    bookThroughDate: promotion?.bookThroughDate ?? '',
    minNights: promotion?.minNights === null ? '' : String(promotion?.minNights ?? ''),
    maxNights: promotion?.maxNights === null ? '' : String(promotion?.maxNights ?? ''),
    minSpend:
      promotion?.minEligibleAmountMinor === null || promotion?.minEligibleAmountMinor === undefined
        ? ''
        : toInput(promotion.minEligibleAmountMinor),
    allPlans: promotion?.appliesToAllRatePlans ?? true,
    planIds: promotion === null ? [] : promotion.ratePlans.map((entry) => entry.id),
    allRooms: promotion?.appliesToAllRoomTypes ?? true,
    roomIds: promotion === null ? [] : promotion.roomTypes.map((entry) => entry.id),
    maxRedemptions:
      promotion?.maxRedemptions === null || promotion?.maxRedemptions === undefined
        ? ''
        : String(promotion.maxRedemptions),
  }));

  const [issues, setIssues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function patch(next: Partial<Draft>): void {
    setDraft((previous) => ({ ...previous, ...next }));
  }

  /**
   * The room types selectable given the chosen plans.
   *
   * The server enforces "a room type must be assigned to a chosen plan"; this
   * narrows the picker so an operator is not offered a combination that will
   * be refused.
   */
  const selectableRooms = (
    draft.allPlans ? plans : plans.filter((plan) => draft.planIds.includes(plan.id))
  ).flatMap((plan) => plan.roomTypes);
  const uniqueRooms = [...new Map(selectableRooms.map((room) => [room.roomTypeId, room])).values()];

  function optionalInt(text: string): number | null {
    if (text.trim().length === 0) return null;
    const parsed = Number(text);
    return Number.isInteger(parsed) ? parsed : null;
  }

  function submit(): void {
    setIssues({});
    setFormError(null);

    const major = Number(draft.value);
    if (draft.value.trim().length === 0 || !Number.isFinite(major) || major < 0) {
      setIssues({ discount: 'Enter a nonnegative discount.' });
      return;
    }
    // Major → minor units for FIXED; percent → basis points for PERCENT. Both
    // scale by 100, for unrelated reasons; rounded once, at the boundary.
    const value = Math.round(major * 100);

    if (!draft.allPlans && draft.planIds.length === 0) {
      setIssues({ ratePlanIds: 'Choose at least one rate plan, or apply to all.' });
      return;
    }
    if (!draft.allRooms && draft.roomIds.length === 0) {
      setIssues({ roomTypeIds: 'Choose at least one room type, or apply to all.' });
      return;
    }

    const body = {
      name: draft.name,
      ...(draft.description.trim().length === 0 ? {} : { description: draft.description }),
      discount: { kind: draft.kind, value },
      priority: Number(draft.priority),
      stayFromDate: draft.stayFromDate.length === 0 ? null : draft.stayFromDate,
      stayThroughDate: draft.stayThroughDate.length === 0 ? null : draft.stayThroughDate,
      bookFromDate: draft.bookFromDate.length === 0 ? null : draft.bookFromDate,
      bookThroughDate: draft.bookThroughDate.length === 0 ? null : draft.bookThroughDate,
      minNights: optionalInt(draft.minNights),
      maxNights: optionalInt(draft.maxNights),
      minEligibleAmountMinor:
        draft.minSpend.trim().length === 0 ? null : Math.round(Number(draft.minSpend) * 100),
      appliesToAllRatePlans: draft.allPlans,
      ratePlanIds: draft.allPlans ? [] : draft.planIds,
      appliesToAllRoomTypes: draft.allRooms,
      roomTypeIds: draft.allRooms ? [] : draft.roomIds,
      maxRedemptions: optionalInt(draft.maxRedemptions),
    };

    startTransition(() => {
      void (async () => {
        try {
          const saved = editing
            ? await updatePromotion(hotelId, promotion.id, body as UpdatePromotionRequest)
            : await createPromotion(hotelId, body as CreatePromotionRequest);
          onSaved(saved);
        } catch (cause) {
          const fieldIssues = issuesFrom(cause);
          if (Object.keys(fieldIssues).length > 0) {
            setIssues(fieldIssues);
            return;
          }
          setFormError(firstMessage(cause, 'That promotion could not be saved.'));
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
          {editing ? `Edit ${promotion.name}` : 'New promotion'}
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

      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Name" error={issues['name']}>
          <input
            value={draft.name}
            onChange={(event) => {
              patch({ name: event.target.value });
            }}
            disabled={pending}
            maxLength={120}
            placeholder="Monsoon 20% off"
            className={inputClass(issues['name'] !== undefined)}
          />
        </Labelled>

        <Labelled
          label="Priority"
          hint="Higher wins when two promotions both qualify."
          error={undefined}
        >
          <input
            type="number"
            min={0}
            max={1000}
            step={1}
            value={draft.priority}
            onChange={(event) => {
              patch({ priority: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(false)} max-w-28 tabular-nums`}
          />
        </Labelled>
      </div>

      {/* The server keys an ambiguous-overlap refusal on `priority`, because
          raising it is the remedy. Shown full-width, not under the number. */}
      {issues['priority'] !== undefined ? (
        <p
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {issues['priority']}
        </p>
      ) : null}

      <Labelled label="Description" hint="Optional." error={issues['description']}>
        <textarea
          value={draft.description}
          onChange={(event) => {
            patch({ description: event.target.value });
          }}
          disabled={pending}
          rows={2}
          maxLength={2000}
          className={`${inputClass(false)} h-auto py-2`}
        />
      </Labelled>

      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Discount type" error={undefined}>
          <select
            value={draft.kind}
            onChange={(event) => {
              patch({ kind: event.target.value as PromotionDiscountKind });
            }}
            disabled={pending}
            className={inputClass(false)}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {PROMOTION_DISCOUNT_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled
          label={draft.kind === 'PERCENT' ? 'Percentage off' : `Amount off per night (${currency})`}
          hint={
            draft.kind === 'PERCENT'
              ? 'Of the night’s amount after extra-person charges. Max 100%.'
              : 'Deducted from each eligible night, capped at the night’s amount.'
          }
          error={issues['discount'] ?? issues['discount.value']}
        >
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              step="0.01"
              value={draft.value}
              onChange={(event) => {
                patch({ value: event.target.value });
              }}
              disabled={pending}
              className={`${inputClass(issues['discount'] !== undefined)} max-w-32 text-right tabular-nums`}
            />
            <span className="text-xs text-muted-foreground">
              {draft.kind === 'PERCENT' ? '%' : currency}
            </span>
          </div>
        </Labelled>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          Eligible nights (inclusive; leave blank for unbounded)
        </legend>
        <Labelled label="First night" error={issues['stayFromDate']}>
          <input
            type="date"
            value={draft.stayFromDate}
            onChange={(event) => {
              patch({ stayFromDate: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(false)} tabular-nums`}
          />
        </Labelled>
        <Labelled label="Last night" error={issues['stayThroughDate']}>
          <input
            type="date"
            value={draft.stayThroughDate}
            onChange={(event) => {
              patch({ stayThroughDate: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(issues['stayThroughDate'] !== undefined)} tabular-nums`}
          />
        </Labelled>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          Booking window (when the booking may be made)
        </legend>
        <Labelled label="Bookable from" error={issues['bookFromDate']}>
          <input
            type="date"
            value={draft.bookFromDate}
            onChange={(event) => {
              patch({ bookFromDate: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(false)} tabular-nums`}
          />
        </Labelled>
        <Labelled label="Bookable until" error={issues['bookThroughDate']}>
          <input
            type="date"
            value={draft.bookThroughDate}
            onChange={(event) => {
              patch({ bookThroughDate: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(issues['bookThroughDate'] !== undefined)} tabular-nums`}
          />
        </Labelled>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-3">
        <Labelled label="Min nights" hint="Eligibility only." error={issues['minNights']}>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.minNights}
            onChange={(event) => {
              patch({ minNights: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(false)} tabular-nums`}
          />
        </Labelled>
        <Labelled label="Max nights" hint="Eligibility only." error={issues['maxNights']}>
          <input
            type="number"
            min={1}
            max={365}
            value={draft.maxNights}
            onChange={(event) => {
              patch({ maxNights: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(issues['maxNights'] !== undefined)} tabular-nums`}
          />
        </Labelled>
        <Labelled
          label={`Min stay spend (${currency})`}
          hint="Pre-tax, pre-discount."
          error={issues['minEligibleAmountMinor']}
        >
          <input
            type="number"
            min={0}
            step="0.01"
            value={draft.minSpend}
            onChange={(event) => {
              patch({ minSpend: event.target.value });
            }}
            disabled={pending}
            className={`${inputClass(false)} text-right tabular-nums`}
          />
        </Labelled>
      </div>

      {/* -- Applicability: explicit, never an empty list meaning "all" --- */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted-foreground">Applies to</legend>

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.allPlans}
            onChange={(event) => {
              patch({ allPlans: event.target.checked, planIds: [] });
            }}
            disabled={pending}
            className="size-4 accent-primary"
          />
          All rate plans
        </label>

        {!draft.allPlans ? (
          <div className="flex flex-wrap gap-1.5">
            {plans.map((plan) => {
              const on = draft.planIds.includes(plan.id);
              return (
                <label
                  key={plan.id}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                    on
                      ? 'border-primary bg-primary/10'
                      : 'border-input bg-background text-muted-foreground hover:bg-accent'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      patch({
                        planIds: on
                          ? draft.planIds.filter((id) => id !== plan.id)
                          : [...draft.planIds, plan.id],
                        // Clearing a plan can orphan a chosen room type, so
                        // the room selection is reset rather than left
                        // referring to a plan no longer included.
                        roomIds: [],
                      });
                    }}
                    disabled={pending}
                    className="size-3.5 accent-primary"
                  />
                  {plan.code}
                </label>
              );
            })}
          </div>
        ) : null}

        {issues['ratePlanIds'] !== undefined ? (
          <p className="text-xs text-destructive" role="alert">
            {issues['ratePlanIds']}
          </p>
        ) : null}

        <label className="mt-1 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={draft.allRooms}
            onChange={(event) => {
              patch({ allRooms: event.target.checked, roomIds: [] });
            }}
            disabled={pending}
            className="size-4 accent-primary"
          />
          All room types
        </label>

        {!draft.allRooms ? (
          <div className="flex flex-wrap gap-1.5">
            {uniqueRooms.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Choose a rate plan first — only room types assigned to it may be selected.
              </p>
            ) : (
              uniqueRooms.map((room) => {
                const on = draft.roomIds.includes(room.roomTypeId);
                return (
                  <label
                    key={room.roomTypeId}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                      on
                        ? 'border-primary bg-primary/10'
                        : 'border-input bg-background text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        patch({
                          roomIds: on
                            ? draft.roomIds.filter((id) => id !== room.roomTypeId)
                            : [...draft.roomIds, room.roomTypeId],
                        });
                      }}
                      disabled={pending}
                      className="size-3.5 accent-primary"
                    />
                    {room.code}
                  </label>
                );
              })
            )}
          </div>
        ) : null}

        {issues['roomTypeIds'] !== undefined ? (
          <p className="text-xs text-destructive" role="alert">
            {issues['roomTypeIds']}
          </p>
        ) : null}
      </fieldset>

      <Labelled
        label="Redemption limit"
        hint="Blank for unlimited. Counting begins when bookings consume promotions (F9); it is always 0 today."
        error={issues['maxRedemptions']}
      >
        <input
          type="number"
          min={1}
          value={draft.maxRedemptions}
          onChange={(event) => {
            patch({ maxRedemptions: event.target.value });
          }}
          disabled={pending}
          className={`${inputClass(false)} max-w-32 tabular-nums`}
        />
      </Labelled>

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
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Create promotion'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Preview                                                                   */
/* -------------------------------------------------------------------------- */

function PromotionPreviewPanel({
  hotelId,
  plans,
  currency,
}: {
  hotelId: string;
  plans: RatePlanView[];
  currency: string;
}) {
  const firstPlan = plans[0];
  const [planId, setPlanId] = useState(firstPlan?.id ?? '');
  const [roomTypeId, setRoomTypeId] = useState(firstPlan?.roomTypes[0]?.roomTypeId ?? '');
  const [arrival, setArrival] = useState(() => todayLocal());
  const [departure, setDeparture] = useState(() => shiftDate(todayLocal(), 2));
  const [bookingDate, setBookingDate] = useState(() => todayLocal());
  const [adults, setAdults] = useState('2');
  const [children, setChildren] = useState('0');
  const [infants, setInfants] = useState('0');
  const [promoCode, setPromoCode] = useState('');

  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const plan = plans.find((entry) => entry.id === planId) ?? null;

  function run(): void {
    setError(null);
    setRunning(true);
    void (async () => {
      try {
        const result = await previewPromotion(hotelId, {
          ratePlanId: planId,
          roomTypeId,
          arrivalDate: arrival as PromotionPreview['arrivalDate'],
          departureDate: departure as PromotionPreview['departureDate'],
          bookingDate: bookingDate as PromotionPreview['bookingDate'],
          adults: Number(adults),
          children: Number(children),
          infants: Number(infants),
          promoCode: promoCode.trim().length === 0 ? null : promoCode.trim(),
        });
        setPreview(result);
      } catch (cause) {
        setPreview(null);
        setError(firstMessage(cause, 'That stay could not be priced.'));
      } finally {
        setRunning(false);
      }
    })();
  }

  if (plans.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-4">
      <div>
        <p className="text-sm font-medium">Preview a stay</p>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Read-only.</span> No redemption is consumed,
          no counter moves, nothing is booked. Every amount is{' '}
          <span className="font-medium text-foreground">pre-tax</span>.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Labelled label="Rate plan" error={undefined}>
          <select
            value={planId}
            onChange={(event) => {
              const next = plans.find((entry) => entry.id === event.target.value) ?? null;
              setPlanId(event.target.value);
              setRoomTypeId(next?.roomTypes[0]?.roomTypeId ?? '');
            }}
            className={`${inputClass(false)} min-w-40`}
          >
            {plans.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="Room type" error={undefined}>
          <select
            value={roomTypeId}
            onChange={(event) => {
              setRoomTypeId(event.target.value);
            }}
            className={`${inputClass(false)} min-w-40`}
          >
            {(plan?.roomTypes ?? []).map((entry) => (
              <option key={entry.roomTypeId} value={entry.roomTypeId}>
                {entry.code}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="Arrival" error={undefined}>
          <input
            type="date"
            value={arrival}
            onChange={(event) => {
              setArrival(event.target.value);
            }}
            className={`${inputClass(false)} tabular-nums`}
          />
        </Labelled>
        <Labelled label="Departure" error={undefined}>
          <input
            type="date"
            value={departure}
            onChange={(event) => {
              setDeparture(event.target.value);
            }}
            className={`${inputClass(false)} tabular-nums`}
          />
        </Labelled>
        <Labelled label="Booked on" hint="Part of eligibility." error={undefined}>
          <input
            type="date"
            value={bookingDate}
            onChange={(event) => {
              setBookingDate(event.target.value);
            }}
            className={`${inputClass(false)} tabular-nums`}
          />
        </Labelled>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {(
          [
            { label: 'Adults', value: adults, set: setAdults, min: 1 },
            { label: 'Children', value: children, set: setChildren, min: 0 },
            { label: 'Infants', value: infants, set: setInfants, min: 0 },
          ] as const
        ).map((field) => (
          <Labelled key={field.label} label={field.label} error={undefined}>
            <input
              type="number"
              min={field.min}
              max={20}
              value={field.value}
              onChange={(event) => {
                field.set(event.target.value);
              }}
              className={`${inputClass(false)} w-20 text-right tabular-nums`}
            />
          </Labelled>
        ))}

        <Labelled label="Promo code" hint="Optional." error={undefined}>
          <input
            value={promoCode}
            onChange={(event) => {
              setPromoCode(event.target.value);
            }}
            maxLength={32}
            placeholder="SUMMER24"
            className={`${inputClass(false)} w-36 uppercase`}
          />
        </Labelled>

        <Button variant="outline" onClick={run} disabled={running}>
          {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Price this stay
        </Button>
      </div>

      {error !== null ? (
        <p
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      {preview !== null ? <PreviewResult preview={preview} currency={currency} /> : null}
    </div>
  );
}

/** The server's calculation, rendered as given. Nothing is derived here. */
function PreviewResult({ preview, currency }: { preview: PromotionPreview; currency: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
      {preview.occupancyRefusals.length > 0 ? (
        <div
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          <span className="font-medium">This guest composition cannot be priced</span>
          <ul className="ml-5 list-disc">
            {preview.occupancyRefusals.map((refusal) => (
              <li key={refusal.code}>{refusal.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.isAmbiguous ? (
        <p
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Two eligible promotions tie on priority, so <strong>none</strong> was applied — the
          undiscounted price is shown. Give one a higher priority to resolve it.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {preview.selectedPromotionName === null ? (
          <>No promotion applied to this stay.</>
        ) : (
          <>
            Applied:{' '}
            <span className="font-medium text-foreground">{preview.selectedPromotionName}</span>
            {preview.selectedCodeId === null ? '' : ' (via a promo code)'}
          </>
        )}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <caption className="sr-only">Per-night pre-tax breakdown</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                Night
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Source
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Base
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Extra guests
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Subtotal
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Discount
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Final
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.perNight.map((night) => (
              <tr key={night.stayDate} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-3 tabular-nums">{night.stayDate}</td>
                <td className="py-1.5 pr-3 text-xs text-muted-foreground">
                  {night.baseRateSource === 'DATE_OVERRIDE'
                    ? 'Typed'
                    : night.baseRateSource === 'DEFAULT'
                      ? 'Default'
                      : night.baseRateSource.charAt(0) +
                        night.baseRateSource.slice(1).toLowerCase()}
                  {night.baseRateRuleName === null ? '' : ` — ${night.baseRateRuleName}`}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatMoney(night.baseRateMinor, currency)}
                </td>
                <td className="py-1.5 pr-3 text-right text-muted-foreground tabular-nums">
                  {formatMoney(night.adultExtraChargeMinor + night.childExtraChargeMinor, currency)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatMoney(night.occupancyAdjustedMinor, currency)}
                </td>
                <td className="py-1.5 pr-3 text-right text-emerald-700 tabular-nums dark:text-emerald-400">
                  {night.discountMinor === 0
                    ? '—'
                    : `−${formatMoney(night.discountMinor, currency)}`}
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums">
                  {formatMoney(night.finalNightlyMinor, currency)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-border font-semibold">
              <td className="py-2 pr-3" colSpan={2}>
                {preview.nights} night{preview.nights === 1 ? '' : 's'} (pre-tax)
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatMoney(preview.baseTotalMinor, currency)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatMoney(preview.extraGuestTotalMinor, currency)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatMoney(preview.occupancyAdjustedTotalMinor, currency)}
              </td>
              <td className="py-2 pr-3 text-right text-emerald-700 tabular-nums dark:text-emerald-400">
                {preview.discountTotalMinor === 0
                  ? '—'
                  : `−${formatMoney(preview.discountTotalMinor, currency)}`}
              </td>
              <td className="py-2 text-right tabular-nums">
                {formatMoney(preview.finalTotalMinor, currency)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Why each promotion did or did not apply — the server's own reasons. */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {preview.candidates.length} promotion(s) considered
        </summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          {preview.candidates.map((candidate) => (
            <li key={candidate.promotionId} className="rounded border border-border/60 p-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{candidate.promotionName}</span>
                <span className="text-muted-foreground">priority {candidate.priority}</span>
                {candidate.eligible ? (
                  <Badge variant="default">eligible</Badge>
                ) : (
                  <Badge variant="secondary">not eligible</Badge>
                )}
                {candidate.promotionId === preview.selectedPromotionId ? (
                  <Badge variant="outline">selected</Badge>
                ) : null}
              </span>
              {candidate.reasons.length > 0 ? (
                <ul className="mt-1 ml-5 list-disc text-muted-foreground">
                  {candidate.reasons.map((reason) => (
                    <li key={reason.code}>{reason.message}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Codes                                                                     */
/* -------------------------------------------------------------------------- */

function CodesDialog({
  hotelId,
  promotion,
  canManage,
  onClose,
}: {
  hotelId: string;
  promotion: PromotionView;
  canManage: boolean;
  onClose: () => void;
}) {
  const [codes, setCodes] = useState<PromoCodeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetchPromoCodes(hotelId, promotion.id, {
            signal: controller.signal,
          });
          setCodes(response.items);
        } catch (cause) {
          if (controller.signal.aborted) return;
          setError(firstMessage(cause, 'The codes could not be loaded.'));
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, 60);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [hotelId, promotion.id]);

  function add(): void {
    setError(null);
    startTransition(() => {
      void (async () => {
        try {
          const saved = await createPromoCode(hotelId, promotion.id, {
            code,
            expiresOn: expiresOn.length === 0 ? null : (expiresOn as PromoCodeView['expiresOn']),
            maxRedemptions: maxRedemptions.trim().length === 0 ? null : Number(maxRedemptions),
          });
          setCodes((previous) => [...previous, saved]);
          setCode('');
          setExpiresOn('');
          setMaxRedemptions('');
        } catch (cause) {
          setError(firstMessage(cause, 'That code could not be created.'));
        }
      })();
    });
  }

  function toggle(entry: PromoCodeView): void {
    setError(null);
    startTransition(() => {
      void (async () => {
        try {
          const saved = await setPromoCodeStatus(hotelId, promotion.id, entry.id, {
            action: entry.isActive ? 'DEACTIVATE' : 'ACTIVATE',
          });
          setCodes((previous) => previous.map((item) => (item.id === saved.id ? saved : item)));
        } catch (cause) {
          setError(firstMessage(cause, 'That code could not be changed.'));
        }
      })();
    });
  }

  function drop(entry: PromoCodeView): void {
    setError(null);
    startTransition(() => {
      void (async () => {
        try {
          await deletePromoCode(hotelId, promotion.id, entry.id);
          setCodes((previous) => previous.filter((item) => item.id !== entry.id));
        } catch (cause) {
          setError(firstMessage(cause, 'That code could not be deleted.'));
        }
      })();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="codes-title"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="codes-title" className="text-base font-semibold">
              Promo codes — {promotion.name}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              A code is how a guest claims this promotion; it carries no discount of its own.
              Matching ignores case and surrounding spaces. A promotion with any code{' '}
              <span className="font-medium text-foreground">requires</span> one — deactivating the
              last code makes it unusable rather than open to everybody.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="size-4" aria-hidden />
          </Button>
        </div>

        {error !== null ? (
          <p
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 inline size-3.5 animate-spin" aria-hidden />
            Loading codes…
          </p>
        ) : codes.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No codes. This promotion currently applies automatically to any eligible stay.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {codes.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium">{entry.code}</span>
                  {entry.isActive ? (
                    <Badge variant="default">active</Badge>
                  ) : (
                    <Badge variant="secondary">inactive</Badge>
                  )}
                  {entry.expiresOn === null ? null : (
                    <span className="text-muted-foreground tabular-nums">
                      expires {entry.expiresOn}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    {entry.maxRedemptions === null
                      ? 'unlimited'
                      : `${String(entry.redeemedCount)}/${String(entry.maxRedemptions)} used`}
                  </span>
                </span>
                {canManage ? (
                  <span className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        toggle(entry);
                      }}
                      disabled={pending}
                      aria-label={`${entry.isActive ? 'Deactivate' : 'Activate'} ${entry.code}`}
                    >
                      {entry.isActive ? (
                        <ToggleRight className="size-4" aria-hidden />
                      ) : (
                        <ToggleLeft className="size-4" aria-hidden />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        drop(entry);
                      }}
                      disabled={pending}
                      aria-label={`Delete ${entry.code}`}
                    >
                      <Trash2 className="size-3.5 text-destructive" aria-hidden />
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <Labelled label="New code" error={undefined}>
              <input
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.toUpperCase());
                }}
                maxLength={32}
                placeholder="SUMMER24"
                className={`${inputClass(false)} w-40 font-mono uppercase`}
              />
            </Labelled>
            <Labelled label="Expires on" hint="Optional, inclusive." error={undefined}>
              <input
                type="date"
                value={expiresOn}
                onChange={(event) => {
                  setExpiresOn(event.target.value);
                }}
                className={`${inputClass(false)} tabular-nums`}
              />
            </Labelled>
            <Labelled label="Max uses" hint="Blank = unlimited." error={undefined}>
              <input
                type="number"
                min={1}
                value={maxRedemptions}
                onChange={(event) => {
                  setMaxRedemptions(event.target.value);
                }}
                className={`${inputClass(false)} w-24 tabular-nums`}
              />
            </Labelled>
            <Button onClick={add} disabled={pending || code.trim().length < 3}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Add code
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Small shared pieces                                                       */
/* -------------------------------------------------------------------------- */

function ConfirmDialog({
  title,
  body,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="promo-confirm-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <h2 id="promo-confirm-title" className="text-base font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
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

function Labelled({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
      {error !== undefined ? (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      ) : hint !== undefined ? (
        <span className="text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

function inputClass(hasError: boolean): string {
  return [
    'h-9 w-full rounded-md border bg-background px-2.5 text-sm',
    'disabled:cursor-not-allowed disabled:opacity-60',
    hasError ? 'border-destructive' : 'border-input',
  ].join(' ');
}
