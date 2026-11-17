'use client';

/**
 * Guest profiles (GP-02): search, create and edit a property's reusable guest
 * profiles; see each one's stay history; link or unlink a booking's guest.
 *
 * Suggestions (stays and profiles sharing an email or phone) are offered with
 * what matched. Nothing links or merges itself; a clerk decides. The server
 * enforces every rule and permission; this screen only renders and asks.
 */

import { cn } from '@repo/ui';
import { Link2, Loader2, Plus, Search, Unlink, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { GuestProfileDetail, GuestProfilePage, GuestStay } from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import {
  createGuestProfile,
  fetchGuestProfile,
  fetchGuestProfiles,
  linkGuestStay,
  unlinkGuestStay,
  updateGuestProfile,
} from '@/lib/properties-client';

const FIELD =
  'w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none disabled:opacity-60';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403)
      return 'Your role cannot change guest profiles (needs reservations:edit).';
    const issues = (cause.details as { issues?: Record<string, string> } | undefined)?.issues;
    const first = issues === undefined ? undefined : Object.values(issues)[0];
    return first ?? cause.message;
  }
  if (cause instanceof ApiUnreachableError)
    return 'The server could not be reached. Nothing was changed.';
  return 'Something went wrong. Nothing was changed.';
}

interface Draft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  countryCode: string;
  preferences: string;
  notes: string;
}

const EMPTY: Draft = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  countryCode: '',
  preferences: '',
  notes: '',
};

function draftOf(profile: GuestProfileDetail): Draft {
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email ?? '',
    phone: profile.phone ?? '',
    countryCode: profile.countryCode ?? '',
    preferences: profile.preferences ?? '',
    notes: profile.notes ?? '',
  };
}

function payloadOf(draft: Draft) {
  const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    email: orNull(draft.email),
    phone: orNull(draft.phone),
    countryCode: orNull(draft.countryCode),
    preferences: orNull(draft.preferences),
    notes: orNull(draft.notes),
  };
}

export function GuestProfilesScreen({
  hotelId,
  initial,
  canEdit,
}: {
  hotelId: string;
  initial: GuestProfilePage;
  canEdit: boolean;
}) {
  const [page, setPage] = useState(initial);
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState('');
  const [selected, setSelected] = useState<GuestProfileDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, work: () => Promise<void>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  const search = (more: boolean) =>
    run('search', async () => {
      const next = await fetchGuestProfiles(hotelId, {
        q: more ? searched : q,
        ...(more && page.nextCursor !== null ? { cursor: page.nextCursor } : {}),
      });
      if (!more) setSearched(q);
      setPage(more ? { items: [...page.items, ...next.items], nextCursor: next.nextCursor } : next);
    });

  const show = (profile: GuestProfileDetail) => {
    setSelected(profile);
    setDraft(draftOf(profile));
  };

  const refreshList = async () => setPage(await fetchGuestProfiles(hotelId, { q: searched }));

  return (
    <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
      {/* ---- List --------------------------------------------------------- */}
      <section aria-label="Guest profiles" className="flex flex-col gap-3">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search(false);
          }}
        >
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Name, email or phone"
            aria-label="Search guest profiles"
            className={FIELD}
          />
          <button
            type="submit"
            aria-label="Search"
            className="rounded-lg border border-white/10 px-2.5 text-zinc-300 hover:border-white/25"
          >
            {busy === 'search' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="size-3.5" aria-hidden="true" />
            )}
          </button>
        </form>
        {canEdit ? (
          <button
            type="button"
            onClick={() => {
              setSelected(null);
              setDraft({ ...EMPTY });
              setError(null);
            }}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:border-white/25"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            New profile
          </button>
        ) : null}
        <ul className="flex flex-col divide-y divide-white/[0.05] rounded-xl border border-white/[0.08]">
          {page.items.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-zinc-500">
              {searched === '' ? 'No guest profiles yet.' : 'No profile matches.'}
            </li>
          ) : (
            page.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    void run(item.id, async () => show(await fetchGuestProfile(hotelId, item.id)))
                  }
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs hover:bg-white/[0.03]',
                    selected?.id === item.id && 'bg-white/[0.05]',
                  )}
                >
                  <span className="font-medium text-zinc-100">
                    {`${item.firstName} ${item.lastName}`.trim()}
                    {busy === item.id ? (
                      <Loader2 className="ml-1.5 inline size-3 animate-spin" aria-hidden="true" />
                    ) : null}
                  </span>
                  <span className="text-zinc-500">
                    {[item.email, item.phone].filter((part) => part !== null).join(' · ') || '—'}
                  </span>
                  <span className="text-[11px] text-zinc-500">
                    {item.stayCount} stay(s)
                    {item.lastArrivalDate === null ? '' : ` · last ${item.lastArrivalDate}`}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        {page.nextCursor === null ? null : (
          <button
            type="button"
            onClick={() => void search(true)}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:border-white/25"
          >
            Load more
          </button>
        )}
      </section>

      {/* ---- Detail ------------------------------------------------------- */}
      <section aria-label="Profile" className="flex flex-col gap-4">
        {error === null ? null : (
          <p
            role="alert"
            className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
          >
            {error}
          </p>
        )}
        {draft === null ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/10 px-6 py-12 text-center text-xs text-zinc-500">
            <UserRound className="size-6" aria-hidden="true" />
            Pick a profile to see its stays, or create one. A profile collects a guest&apos;s
            bookings at this property, their preferences and internal notes.
          </div>
        ) : (
          <form
            className="flex flex-col gap-3 rounded-xl border border-white/[0.08] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run('save', async () => {
                const body = payloadOf(draft);
                const saved =
                  selected === null
                    ? await createGuestProfile(hotelId, body)
                    : await updateGuestProfile(hotelId, selected.id, body);
                show(saved);
                await refreshList();
              });
            }}
          >
            <h2 className="text-sm font-semibold text-white">
              {selected === null
                ? 'New guest profile'
                : `${selected.firstName} ${selected.lastName}`.trim()}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['firstName', 'First name'],
                  ['lastName', 'Last name'],
                  ['email', 'Email'],
                  ['phone', 'Phone'],
                  ['countryCode', 'Country (2 letters)'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-1 text-[11px] text-zinc-500">
                  {label}
                  <input
                    value={draft[key]}
                    disabled={!canEdit}
                    required={key === 'firstName'}
                    maxLength={key === 'countryCode' ? 2 : 100}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                    className={FIELD}
                  />
                </label>
              ))}
            </div>
            {(
              [
                ['preferences', 'Preferences (room, pillow, diet…)'],
                ['notes', 'Internal notes'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-1 text-[11px] text-zinc-500">
                {label}
                <textarea
                  value={draft[key]}
                  disabled={!canEdit}
                  rows={2}
                  maxLength={2000}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  className={FIELD}
                />
              </label>
            ))}
            {canEdit ? (
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busy === 'save'}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
                >
                  {busy === 'save' ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : null}
                  {selected === null ? 'Create profile' : 'Save'}
                </button>
              </div>
            ) : null}
          </form>
        )}

        {selected === null ? null : (
          <>
            <StayList
              title={`Stays (${String(selected.stays.length)})`}
              empty="No stays linked yet."
              stays={selected.stays}
              action={
                canEdit
                  ? {
                      label: 'Unlink',
                      icon: Unlink,
                      run: (stay) =>
                        void run(stay.reservationGuestId, async () => {
                          show(
                            await unlinkGuestStay(hotelId, selected.id, stay.reservationGuestId),
                          );
                          await refreshList();
                        }),
                    }
                  : null
              }
              busy={busy}
            />
            {selected.suggestedStays.length === 0 ? null : (
              <StayList
                title="Stays that may be this guest"
                empty=""
                hint="Same email or phone. Link only if it is the same person."
                stays={selected.suggestedStays}
                action={
                  canEdit
                    ? {
                        label: 'Link',
                        icon: Link2,
                        run: (stay) =>
                          void run(stay.reservationGuestId, async () => {
                            show(
                              await linkGuestStay(hotelId, selected.id, stay.reservationGuestId),
                            );
                            await refreshList();
                          }),
                      }
                    : null
                }
                busy={busy}
              />
            )}
            {selected.possibleDuplicates.length === 0 ? null : (
              <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
                Other profiles share this guest&apos;s{' '}
                {[...new Set(selected.possibleDuplicates.flatMap((dup) => dup.matchedOn))].join(
                  ' or ',
                )}
                :{' '}
                {selected.possibleDuplicates.map((dup, index) => (
                  <button
                    key={dup.id}
                    type="button"
                    onClick={() =>
                      void run(dup.id, async () => show(await fetchGuestProfile(hotelId, dup.id)))
                    }
                    className="underline hover:text-white"
                  >
                    {`${dup.firstName} ${dup.lastName}`.trim()}
                    {index < selected.possibleDuplicates.length - 1 ? ', ' : ''}
                  </button>
                ))}
                . Profiles are never merged automatically; move stays between them by unlinking and
                linking.
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function StayList({
  title,
  empty,
  hint,
  stays,
  action,
  busy,
}: {
  title: string;
  empty: string;
  hint?: string;
  stays: readonly (GuestStay & { matchedOn?: readonly string[] })[];
  action: { label: string; icon: typeof Link2; run: (stay: GuestStay) => void } | null;
  busy: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] tracking-wide text-zinc-500 uppercase">{title}</h3>
      {hint === undefined ? null : <p className="text-[11px] text-zinc-500">{hint}</p>}
      {stays.length === 0 ? (
        <p className="text-xs text-zinc-500">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-white/[0.05] rounded-xl border border-white/[0.08]">
          {stays.map((stay) => (
            <li
              key={stay.reservationGuestId}
              className="tabular flex items-center gap-3 px-3 py-2 text-xs"
            >
              <span className="font-mono text-zinc-200">{stay.bookingCode}</span>
              <span className="text-zinc-400">
                {stay.arrivalDate} → {stay.departureDate}
              </span>
              <span className="text-zinc-500">{stay.status.toLowerCase().replace('_', ' ')}</span>
              <span className="text-zinc-400">{stay.guestName}</span>
              {stay.matchedOn === undefined ? null : (
                <span className="text-[11px] text-amber-300">
                  matched on {stay.matchedOn.join(' + ')}
                </span>
              )}
              <span className="ml-auto text-zinc-300">
                {formatMoney(stay.totalAmountMinor, stay.currency)}
              </span>
              {action === null ? null : (
                <button
                  type="button"
                  disabled={busy === stay.reservationGuestId}
                  onClick={() => action.run(stay)}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/25 disabled:opacity-60"
                >
                  <action.icon className="size-3" aria-hidden="true" />
                  {action.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
