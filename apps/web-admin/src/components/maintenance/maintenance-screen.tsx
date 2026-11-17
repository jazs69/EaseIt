'use client';

/**
 * Maintenance (MA-01): report a fault on a room, see the open work orders,
 * and move each through assign, start, resolve or cancel.
 *
 * Taking a room out of order (now, or later from an order) withholds it from
 * sale for the range; resolving or cancelling gives it back from the business
 * date. The server enforces every permission and inventory rule; the buttons
 * are offered by what the caller's role carries, and a refusal is shown in
 * the server's words.
 */

import { cn } from '@repo/ui';
import { Loader2, Plus, Wrench } from 'lucide-react';
import { useState } from 'react';
import {
  WORK_ORDER_PRIORITY_LABELS,
  WORK_ORDER_STATUS_LABELS,
  workOrderPrioritySchema,
  type WorkOrder,
  type WorkOrderList,
  type WorkOrderPriority,
} from '@repo/types';

import { ApiRequestError, ApiUnreachableError } from '@/lib/api';
import {
  assignWorkOrder,
  cancelWorkOrder,
  createWorkOrder,
  fetchWorkOrders,
  resolveWorkOrder,
  startWorkOrder,
  takeRoomOutOfOrder,
} from '@/lib/properties-client';

const FIELD =
  'w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-white/20 focus:outline-none';

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 403) return 'Your role cannot do this here.';
    const details = cause.details as
      { issues?: Record<string, string>; reason?: string; conflictsWith?: string } | undefined;
    const first = details?.issues === undefined ? undefined : Object.values(details.issues)[0];
    if (first !== undefined) return first;
    if (details?.reason !== undefined) {
      return details.conflictsWith === undefined
        ? details.reason
        : `${details.reason} (${details.conflictsWith})`;
    }
    return cause.message;
  }
  if (cause instanceof ApiUnreachableError)
    return 'The server could not be reached. Nothing was changed.';
  if (cause instanceof Error && cause.name === 'Error') return cause.message;
  return 'Something went wrong. Nothing was changed.';
}

const PRIORITY_TONE: Record<WorkOrderPriority, string> = {
  LOW: 'text-zinc-400',
  NORMAL: 'text-zinc-300',
  HIGH: 'text-amber-300',
  URGENT: 'text-rose-300',
};

interface Room {
  roomId: string;
  number: string;
  roomTypeName: string;
  occupied: boolean;
}

export function MaintenanceScreen({
  hotelId,
  initial,
  rooms,
  canManage,
  canBlock,
}: {
  hotelId: string;
  initial: WorkOrderList;
  rooms: readonly Room[];
  canManage: boolean;
  canBlock: boolean;
}) {
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{
    roomId: string;
    title: string;
    description: string;
    priority: WorkOrderPriority;
    outOfOrder: boolean;
    fromDate: string;
    throughDate: string;
  } | null>(null);
  const today = data.businessDate;

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

  const reload = (status: 'active' | 'all' = filter) =>
    run('load', async () => {
      setData(await fetchWorkOrders(hotelId, status));
    });

  const replace = (order: WorkOrder) =>
    setData((current) => ({
      ...current,
      items: current.items.some((item) => item.id === order.id)
        ? current.items.map((item) => (item.id === order.id ? order : item))
        : [order, ...current.items],
    }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() =>
            setForm({
              roomId: rooms[0]?.roomId ?? '',
              title: '',
              description: '',
              priority: 'NORMAL',
              outOfOrder: false,
              fromDate: today,
              throughDate: today,
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Report a fault
        </button>
        <div className="ml-auto flex gap-1 rounded-lg border border-white/[0.08] p-0.5 text-xs">
          {(['active', 'all'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setFilter(value);
                void reload(value);
              }}
              className={cn(
                'rounded-md px-2.5 py-1',
                filter === value
                  ? 'bg-white/[0.08] text-white'
                  : 'text-zinc-400 hover:text-zinc-200',
              )}
            >
              {value === 'active' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {error === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </p>
      )}

      {form === null ? null : (
        <form
          className="flex flex-col gap-3 rounded-xl border border-white/[0.08] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run('create', async () => {
              const created = await createWorkOrder(hotelId, {
                roomId: form.roomId,
                title: form.title,
                description: form.description.trim() === '' ? null : form.description,
                priority: form.priority,
                outOfOrder: form.outOfOrder
                  ? { fromDate: form.fromDate, throughDate: form.throughDate }
                  : null,
              } as Parameters<typeof createWorkOrder>[1]);
              replace(created);
              setForm(null);
            });
          }}
        >
          <h2 className="text-sm font-semibold text-white">Report a fault</h2>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr_9rem]">
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
              Room
              <select
                value={form.roomId}
                onChange={(event) => setForm({ ...form, roomId: event.target.value })}
                className={FIELD}
                required
              >
                {rooms.map((room) => (
                  <option key={room.roomId} value={room.roomId}>
                    {room.number} · {room.roomTypeName}
                    {room.occupied ? ' (occupied)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
              What is wrong
              <input
                value={form.title}
                maxLength={120}
                required
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder="e.g. AC not cooling"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
              Priority
              <select
                value={form.priority}
                onChange={(event) =>
                  setForm({ ...form, priority: workOrderPrioritySchema.parse(event.target.value) })
                }
                className={FIELD}
              >
                {workOrderPrioritySchema.options.map((priority) => (
                  <option key={priority} value={priority}>
                    {WORK_ORDER_PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Details (optional)
            <textarea
              value={form.description}
              rows={2}
              maxLength={2000}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              className={FIELD}
            />
          </label>
          {canBlock ? (
            <div className="flex flex-wrap items-end gap-3 text-xs text-zinc-300">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={form.outOfOrder}
                  onChange={(event) => setForm({ ...form, outOfOrder: event.target.checked })}
                />
                Take the room out of order
              </label>
              {form.outOfOrder ? (
                <>
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
                    First night
                    <input
                      type="date"
                      value={form.fromDate}
                      min={today}
                      onChange={(event) => setForm({ ...form, fromDate: event.target.value })}
                      className={FIELD}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
                    Last night
                    <input
                      type="date"
                      value={form.throughDate}
                      min={form.fromDate}
                      onChange={(event) => setForm({ ...form, throughDate: event.target.value })}
                      className={FIELD}
                    />
                  </label>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:border-white/25"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy === 'create'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
            >
              {busy === 'create' ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              Report
            </button>
          </div>
        </form>
      )}

      <ul className="flex flex-col divide-y divide-white/[0.05] rounded-xl border border-white/[0.08]">
        {data.items.length === 0 ? (
          <li className="flex flex-col items-center gap-2 px-6 py-10 text-center text-xs text-zinc-500">
            <Wrench className="size-5" aria-hidden="true" />
            {filter === 'active' ? 'No open work orders.' : 'No work orders yet.'}
          </li>
        ) : (
          data.items.map((order) => (
            <OrderRow
              key={order.id}
              hotelId={hotelId}
              order={order}
              assignees={data.assignees}
              businessDate={today}
              canManage={canManage}
              canBlock={canBlock}
              busy={busy}
              run={run}
              onChanged={replace}
            />
          ))
        )}
      </ul>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Taking a room out of order withholds it from sale for the nights chosen; a room with a guest
        on those nights is refused. Resolving or cancelling the order gives the room back from the
        business date ({today}); nights already spent out of order stay recorded.
      </p>
    </div>
  );
}

function OrderRow({
  hotelId,
  order,
  assignees,
  businessDate,
  canManage,
  canBlock,
  busy,
  run,
  onChanged,
}: {
  hotelId: string;
  order: WorkOrder;
  assignees: WorkOrderList['assignees'];
  businessDate: string;
  canManage: boolean;
  canBlock: boolean;
  busy: string | null;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  onChanged: (order: WorkOrder) => void;
}) {
  const active = order.status === 'OPEN' || order.status === 'IN_PROGRESS';
  const [note, setNote] = useState('');
  const [range, setRange] = useState({ fromDate: businessDate, throughDate: businessDate });
  const act = (label: string, work: () => Promise<WorkOrder>) =>
    void run(`${order.id}:${label}`, async () => onChanged(await work()));
  const pending = (label: string) => busy === `${order.id}:${label}`;
  const button =
    'rounded-md border border-white/10 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/25 disabled:opacity-60';

  return (
    <li className="flex flex-col gap-2 px-3 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-zinc-100">Room {order.roomNumber}</span>
        <span className="font-medium text-white">{order.title}</span>
        <span className={PRIORITY_TONE[order.priority]}>
          {WORK_ORDER_PRIORITY_LABELS[order.priority]}
        </span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px]',
            active ? 'bg-amber-500/10 text-amber-200' : 'bg-white/[0.05] text-zinc-400',
          )}
        >
          {WORK_ORDER_STATUS_LABELS[order.status]}
        </span>
        {order.outOfOrder === null ? null : (
          <span
            className={cn(
              'text-[11px]',
              order.outOfOrder.active ? 'text-rose-300' : 'text-zinc-500',
            )}
          >
            {order.outOfOrder.active ? 'Out of order' : 'Was out of order'}{' '}
            {order.outOfOrder.fromDate} → {order.outOfOrder.throughDate}
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-500">
          {order.reportedBy.name} · {order.createdAt.slice(0, 10)}
        </span>
      </div>
      {order.description === null ? null : <p className="text-zinc-400">{order.description}</p>}
      {order.resolutionNote === null ? null : (
        <p className="text-zinc-500">Closing note: {order.resolutionNote}</p>
      )}
      {canManage && active ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Assigned to"
            value={order.assignedTo?.id ?? ''}
            onChange={(event) =>
              act('assign', () =>
                assignWorkOrder(hotelId, order.id, {
                  assignedToId: event.target.value === '' ? null : event.target.value,
                }),
              )
            }
            className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-200"
          >
            <option value="">Unassigned</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
          {order.status === 'OPEN' ? (
            <button
              type="button"
              disabled={pending('start')}
              className={button}
              onClick={() => act('start', () => startWorkOrder(hotelId, order.id))}
            >
              Start
            </button>
          ) : null}
          {canBlock && (order.outOfOrder === null || !order.outOfOrder.active) ? (
            <span className="flex items-center gap-1">
              <input
                type="date"
                aria-label="Out of order from"
                value={range.fromDate}
                min={businessDate}
                onChange={(event) => setRange({ ...range, fromDate: event.target.value })}
                className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-1 text-[11px] text-zinc-200"
              />
              <input
                type="date"
                aria-label="Out of order through"
                value={range.throughDate}
                min={range.fromDate}
                onChange={(event) => setRange({ ...range, throughDate: event.target.value })}
                className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-1 text-[11px] text-zinc-200"
              />
              <button
                type="button"
                disabled={pending('ooo')}
                className={button}
                onClick={() =>
                  act('ooo', () =>
                    takeRoomOutOfOrder(
                      hotelId,
                      order.id,
                      range as Parameters<typeof takeRoomOutOfOrder>[2],
                    ),
                  )
                }
              >
                Take out of order
              </button>
            </span>
          ) : null}
          <input
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Closing note"
            className="min-w-[10rem] flex-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-200"
          />
          <button
            type="button"
            disabled={pending('resolve')}
            className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
            onClick={() =>
              act('resolve', () =>
                resolveWorkOrder(hotelId, order.id, note.trim() === '' ? null : note.trim()),
              )
            }
          >
            Resolve
          </button>
          <button
            type="button"
            disabled={pending('cancel')}
            className={button}
            onClick={() =>
              act('cancel', () =>
                cancelWorkOrder(hotelId, order.id, note.trim() === '' ? null : note.trim()),
              )
            }
          >
            Cancel order
          </button>
        </div>
      ) : order.assignedTo === null ? null : (
        <p className="text-[11px] text-zinc-500">Assigned to {order.assignedTo.name}</p>
      )}
    </li>
  );
}
