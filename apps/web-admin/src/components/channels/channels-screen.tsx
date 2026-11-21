'use client';

/**
 * Channels (CM-01 .. CM-05): connect the property to a channel provider, map
 * room types and rate plans, switch distribution on or off, watch pushes and
 * pulls, and deal with inbound OTA bookings the system would not place on
 * its own. Nothing here talks to a provider: the worker does, and this screen
 * reads what it recorded. Every refusal is shown in the server's words.
 */

import { cn } from '@repo/ui';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  CHANNEL_ATTENTION_LABELS,
  type ChannelConnection,
  type ChannelInboundMessage,
  type ChannelOverview,
  type ChannelProvider,
  type ChannelSyncAttempt,
} from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import {
  actOnChannelInbound,
  createChannelConnection,
  fetchChannelAttempts,
  fetchChannelInbound,
  fetchChannelOverview,
  saveChannelMappings,
  setChannelActive,
  syncChannel,
} from '@/lib/properties-client';

const FIELD =
  'w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none';
const BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/[0.05] disabled:opacity-50';
const PRIMARY =
  'inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403) return 'Your role cannot do this here.';
    const details = cause.details as { issues?: Record<string, string> } | undefined;
    const first = details?.issues === undefined ? undefined : Object.values(details.issues)[0];
    return first ?? cause.message;
  }
  if (cause instanceof ApiUnreachableError)
    return 'The server could not be reached. Nothing was changed.';
  return 'Something went wrong. Nothing was changed.';
}

const when = (value: string | null): string =>
  value === null
    ? 'never'
    : new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function ChannelsScreen({
  hotelId,
  initial,
  canManage,
  canSync,
}: {
  hotelId: string;
  initial: ChannelOverview;
  canManage: boolean;
  canSync: boolean;
}) {
  const [overview, setOverview] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, work: () => Promise<unknown>) => {
      setBusy(label);
      setError(null);
      try {
        await work();
        setOverview(await fetchChannelOverview(hotelId));
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(null);
      }
    },
    [hotelId],
  );

  return (
    <div className="flex flex-col gap-6">
      {error === null ? null : (
        <div
          role="alert"
          className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </div>
      )}

      {overview.connections.length === 0 ? (
        <ConnectForm
          overview={overview}
          canManage={canManage}
          busy={busy}
          run={run}
          hotelId={hotelId}
        />
      ) : (
        overview.connections.map((connection) => (
          <ConnectionPanel
            key={connection.id}
            hotelId={hotelId}
            overview={overview}
            connection={connection}
            canManage={canManage}
            canSync={canSync}
            busy={busy}
            run={run}
          />
        ))
      )}
    </div>
  );
}

type Run = (label: string, work: () => Promise<unknown>) => Promise<void>;

function ConnectForm({
  hotelId,
  overview,
  canManage,
  busy,
  run,
}: {
  hotelId: string;
  overview: ChannelOverview;
  canManage: boolean;
  busy: string | null;
  run: Run;
}) {
  const [provider, setProvider] = useState<ChannelProvider>(
    overview.providers[0]?.provider ?? 'CHANNEX',
  );
  const [externalId, setExternalId] = useState('');
  const chosen = overview.providers.find((p) => p.provider === provider);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/[0.08] p-4">
      <h2 className="text-sm font-semibold text-white">Connect a channel provider</h2>
      <p className="text-xs text-zinc-400">
        The connection starts paused. Map room types and rate plans, then switch it on: the whole
        calendar is pushed once, and every change after that.
      </p>
      {canManage ? (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void run('connect', () =>
              createChannelConnection(hotelId, { provider, externalPropertyId: externalId }),
            );
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Provider
            <select
              className={FIELD}
              value={provider}
              onChange={(e) => setProvider(e.target.value as ChannelProvider)}
            >
              {overview.providers.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            The provider&apos;s property id
            <input
              className={FIELD}
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <button
            type="submit"
            className={cn(PRIMARY, 'self-end')}
            disabled={busy !== null || externalId.trim() === ''}
          >
            {busy === 'connect' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            Connect
          </button>
        </form>
      ) : (
        <p className="text-xs text-zinc-500">Connecting a provider needs channels:manage.</p>
      )}
      {chosen !== undefined && !chosen.configured ? (
        <p className="text-xs text-amber-300">
          This server holds no credentials for {chosen.label}. You can connect and map now; nothing
          is sent until they are configured.
        </p>
      ) : null}
    </section>
  );
}

function ConnectionPanel({
  hotelId,
  overview,
  connection,
  canManage,
  canSync,
  busy,
  run,
}: {
  hotelId: string;
  overview: ChannelOverview;
  connection: ChannelConnection;
  canManage: boolean;
  canSync: boolean;
  busy: string | null;
  run: Run;
}) {
  const label =
    overview.providers.find((p) => p.provider === connection.provider)?.label ??
    connection.provider;
  const active = connection.status === 'ACTIVE';

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-xl border border-white/[0.08] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-white">{label}</h2>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-500/15 text-zinc-300',
            )}
          >
            {active ? 'On' : 'Paused'}
          </span>
          <span className="text-xs text-zinc-500">Property id {connection.externalPropertyId}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            {canSync && active ? (
              <>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null}
                  onClick={() => void run('sync', () => syncChannel(hotelId, connection.id, false))}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  Sync now
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null}
                  onClick={() => void run('full', () => syncChannel(hotelId, connection.id, true))}
                >
                  Full resync
                </button>
              </>
            ) : null}
            {canManage ? (
              <button
                type="button"
                className={active ? BUTTON : PRIMARY}
                disabled={busy !== null}
                onClick={() =>
                  void run('toggle', () => setChannelActive(hotelId, connection.id, !active))
                }
              >
                {busy === 'toggle' ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                {active ? 'Pause' : 'Switch on'}
              </button>
            ) : null}
          </div>
        </div>
        {!connection.providerConfigured ? (
          <p className="text-xs text-amber-300">
            This server holds no credentials for the provider; nothing is sent or fetched.
          </p>
        ) : null}
        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <Fact
            term="Last push"
            value={when(connection.lastAriSyncAt)}
            problem={connection.lastAriError}
          />
          <Fact
            term="Last booking fetch"
            value={when(connection.lastPulledAt)}
            problem={connection.lastPullError}
          />
          <Fact
            term="Changes waiting to be pushed"
            value={String(connection.pendingAriChanges)}
            problem={null}
          />
          <Fact
            term="Bookings needing attention"
            value={String(connection.inboundNeedingAttention)}
            problem={connection.inboundNeedingAttention > 0 ? 'See below.' : null}
          />
        </dl>
      </section>

      <MappingEditor
        hotelId={hotelId}
        overview={overview}
        connection={connection}
        canManage={canManage}
        busy={busy}
        run={run}
      />
      <InboundList
        hotelId={hotelId}
        connection={connection}
        canManage={canManage}
        onChanged={() => void run('refresh', async () => undefined)}
      />
      <AttemptLog hotelId={hotelId} connectionId={connection.id} />
    </div>
  );
}

function Fact({ term, value, problem }: { term: string; value: string; problem: string | null }) {
  return (
    <div className="flex flex-col">
      <dt className="text-zinc-500">{term}</dt>
      <dd className="text-zinc-200">
        {value}
        {problem === null ? null : <span className="ml-2 text-amber-300">{problem}</span>}
      </dd>
    </div>
  );
}

function MappingEditor({
  hotelId,
  overview,
  connection,
  canManage,
  busy,
  run,
}: {
  hotelId: string;
  overview: ChannelOverview;
  connection: ChannelConnection;
  canManage: boolean;
  busy: string | null;
  run: Run;
}) {
  const initialRooms = (): Record<string, string> =>
    Object.fromEntries(connection.mappings.map((m) => [m.roomTypeId, m.externalRoomTypeId]));
  const initialPlans = (): Record<string, string> =>
    Object.fromEntries(
      connection.mappings.flatMap((m) =>
        m.ratePlans.map((p) => [`${m.roomTypeId}:${p.ratePlanId}`, p.externalRatePlanId]),
      ),
    );
  const [rooms, setRooms] = useState(initialRooms);
  const [plans, setPlans] = useState(initialPlans);

  const save = (): Promise<unknown> =>
    saveChannelMappings(hotelId, connection.id, {
      roomTypes: overview.roomTypes
        .filter((type) => (rooms[type.roomTypeId] ?? '').trim() !== '')
        .map((type) => ({
          roomTypeId: type.roomTypeId,
          externalRoomTypeId: (rooms[type.roomTypeId] ?? '').trim(),
          ratePlans: type.ratePlans
            .filter((plan) => (plans[`${type.roomTypeId}:${plan.ratePlanId}`] ?? '').trim() !== '')
            .map((plan) => ({
              ratePlanId: plan.ratePlanId,
              externalRatePlanId: (plans[`${type.roomTypeId}:${plan.ratePlanId}`] ?? '').trim(),
            })),
        })),
    });

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/[0.08] p-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-white">Mapping</h2>
        <p className="text-xs text-zinc-500">
          The provider&apos;s ids for each room type, and for each rate plan sold through it. Blank
          means not sold on the channels.
        </p>
      </div>
      <div className="flex flex-col divide-y divide-white/[0.06]">
        {overview.roomTypes
          .filter((type) => !type.retired)
          .map((type) => (
            <div key={type.roomTypeId} className="grid gap-2 py-3 sm:grid-cols-[14rem_1fr]">
              <div className="text-xs">
                <div className="font-medium text-zinc-200">{type.name}</div>
                <div className="text-zinc-500">{type.code}</div>
              </div>
              <div className="flex flex-col gap-2">
                <input
                  className={FIELD}
                  placeholder="Provider room type id"
                  aria-label={`Provider room type id for ${type.name}`}
                  value={rooms[type.roomTypeId] ?? ''}
                  disabled={!canManage}
                  maxLength={100}
                  onChange={(e) => setRooms({ ...rooms, [type.roomTypeId]: e.target.value })}
                />
                {type.ratePlans.map((plan) => (
                  <label
                    key={plan.ratePlanId}
                    className="grid items-center gap-2 text-xs text-zinc-400 sm:grid-cols-[12rem_1fr]"
                  >
                    <span>
                      {plan.name} <span className="text-zinc-600">{plan.code}</span>
                      {plan.active ? null : (
                        <span className="ml-1 text-amber-300">(inactive: pushed as closed)</span>
                      )}
                    </span>
                    <input
                      className={FIELD}
                      placeholder="Provider rate plan id"
                      value={plans[`${type.roomTypeId}:${plan.ratePlanId}`] ?? ''}
                      disabled={!canManage || (rooms[type.roomTypeId] ?? '').trim() === ''}
                      maxLength={100}
                      onChange={(e) =>
                        setPlans({
                          ...plans,
                          [`${type.roomTypeId}:${plan.ratePlanId}`]: e.target.value,
                        })
                      }
                    />
                  </label>
                ))}
                {type.ratePlans.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    No rate plan prices this room type; only availability is pushed.
                  </p>
                ) : null}
              </div>
            </div>
          ))}
      </div>
      {canManage ? (
        <div className="flex justify-end">
          <button
            type="button"
            className={PRIMARY}
            disabled={busy !== null}
            onClick={() => void run('mappings', save)}
          >
            {busy === 'mappings' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            Save mapping
          </button>
        </div>
      ) : null}
    </section>
  );
}

function InboundList({
  hotelId,
  connection,
  canManage,
  onChanged,
}: {
  hotelId: string;
  connection: ChannelConnection;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [items, setItems] = useState<ChannelInboundMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchChannelInbound(hotelId, connection.id, filter)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [hotelId, connection.id, filter, version]);

  const act = async (
    message: ChannelInboundMessage,
    action: 'retry' | 'resolve',
  ): Promise<void> => {
    const note = action === 'resolve' ? (window.prompt('What was done? (optional)') ?? null) : null;
    setActing(message.id);
    setError(null);
    try {
      await actOnChannelInbound(
        hotelId,
        connection.id,
        message.id,
        action,
        note === '' ? null : note,
      );
      setVersion((v) => v + 1);
      onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setActing(null);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/[0.08] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-white">Inbound bookings</h2>
        <div className="ml-auto flex gap-1 rounded-lg border border-white/[0.08] p-0.5 text-xs">
          {(['attention', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-md px-2 py-1',
                filter === value ? 'bg-white/[0.08] text-white' : 'text-zinc-400',
              )}
            >
              {value === 'attention' ? 'Needs attention' : 'All'}
            </button>
          ))}
        </div>
      </div>
      {error === null ? null : <p className="text-xs text-rose-300">{error}</p>}
      {items === null ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-zinc-400">
          <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden="true" />
          {filter === 'attention' ? 'Nothing needs attention.' : 'No bookings received yet.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-white/[0.06]">
          {items.map((message) => (
            <li key={message.id} className="flex flex-col gap-1 py-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                {message.status === 'NEEDS_ATTENTION' ? (
                  <AlertTriangle className="size-3.5 text-amber-300" aria-hidden="true" />
                ) : null}
                <span className="font-medium text-zinc-200">
                  {message.summary === null
                    ? `Message ${message.externalMessageId}`
                    : `${message.summary.guestName} · ${message.summary.arrivalDate} → ${message.summary.departureDate}`}
                </span>
                <span className="text-zinc-500">
                  {message.summary?.otaName ?? ''} {message.summary?.otaReservationCode ?? ''} ·{' '}
                  {message.revisionKind ?? '—'}
                </span>
                <span className="text-zinc-500">
                  {message.status.replace('_', ' ').toLowerCase()}
                </span>
                {message.attentionCode === null ? null : (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                    {CHANNEL_ATTENTION_LABELS[message.attentionCode]}
                  </span>
                )}
              </div>
              {message.outcome === null ? null : <p className="text-zinc-400">{message.outcome}</p>}
              {message.reservations.length > 0 ? (
                <p className="text-zinc-500">
                  Reservations: {message.reservations.map((r) => r.confirmationCode).join(', ')}
                </p>
              ) : null}
              {canManage && message.status === 'NEEDS_ATTENTION' ? (
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={acting !== null}
                    onClick={() => void act(message, 'retry')}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={acting !== null}
                    onClick={() => void act(message, 'resolve')}
                  >
                    Mark resolved
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AttemptLog({ hotelId, connectionId }: { hotelId: string; connectionId: string }) {
  const [items, setItems] = useState<ChannelSyncAttempt[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchChannelAttempts(hotelId, connectionId)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNext(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [hotelId, connectionId]);

  const older = async (cursor: string): Promise<void> => {
    try {
      const page = await fetchChannelAttempts(hotelId, connectionId, cursor);
      setItems((current) => [...(current ?? []), ...page.items]);
      setNext(page.nextCursor);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/[0.08] p-4">
      <h2 className="text-sm font-semibold text-white">Provider calls</h2>
      {error === null ? null : <p className="text-xs text-rose-300">{error}</p>}
      {items === null ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-zinc-500">No calls yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-white/[0.06] text-xs">
          {items.map((attempt) => (
            <li key={attempt.id} className="py-2">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span className={attempt.ok ? 'text-emerald-300' : 'text-rose-300'}>
                    {attempt.ok ? 'OK' : 'Failed'}
                  </span>
                  <span className="text-zinc-200">{attempt.operation}</span>
                  <span className="text-zinc-500">
                    {attempt.method} {attempt.path}
                  </span>
                  <span className="text-zinc-500">
                    {attempt.responseStatus ?? '—'} · {attempt.durationMs} ms ·{' '}
                    {when(attempt.createdAt)}
                  </span>
                  {attempt.error === null ? null : (
                    <span className="text-rose-300">{attempt.error}</span>
                  )}
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <pre className="max-h-64 overflow-auto rounded-lg bg-black/30 p-2 text-[11px] text-zinc-300">
                    {attempt.requestBody === null
                      ? 'No request body recorded.'
                      : JSON.stringify(attempt.requestBody, null, 2)}
                  </pre>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-black/30 p-2 text-[11px] text-zinc-300">
                    {attempt.responseBody === null
                      ? 'No response body recorded.'
                      : JSON.stringify(attempt.responseBody, null, 2)}
                  </pre>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {next === null ? null : (
        <button type="button" className={cn(BUTTON, 'self-start')} onClick={() => void older(next)}>
          Older calls
        </button>
      )}
    </section>
  );
}
