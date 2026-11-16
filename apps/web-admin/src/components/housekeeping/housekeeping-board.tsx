'use client';

/**
 * The housekeeping board (HK-02 .. HK-04).
 *
 * Every room as a card: status, whether a guest is in it or due in or out
 * today, and its open tasks with the actions the caller may take. The server
 * decides every permission; a refused action shows its reason here rather
 * than the screen guessing who may do what.
 */

import { cn } from '@repo/ui';
import { BrushCleaning, ClipboardCheck, Loader2, LogIn, LogOut, Play, RefreshCw, Sparkles, User } from 'lucide-react';
import { useState } from 'react';
import type { HousekeepingBoard, HousekeepingBoardRoom, HousekeepingTaskView } from '@repo/types';

import {
  actOnHousekeepingTask,
  createHousekeepingTask,
  fetchHousekeepingBoard,
  queueHousekeepingCleaning,
} from '@/lib/properties-client';

const STATUS_TONE: Record<string, string> = {
  VACANT_CLEAN: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  INSPECTED: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  VACANT_DIRTY: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  OCCUPIED_CLEAN: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  OCCUPIED_DIRTY: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  OUT_OF_SERVICE: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
  OUT_OF_ORDER: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
};

const TASK_LABEL: Record<HousekeepingTaskView['type'], string> = {
  CLEAN: 'Clean',
  DEEP_CLEAN: 'Deep clean',
  TURNDOWN: 'Turndown',
  INSPECTION: 'Inspection',
};

function label(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ');
}

export function HousekeepingBoardView({ hotelId, initial }: { hotelId: string; initial: HousekeepingBoard }) {
  const [board, setBoard] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'dirty' | 'tasks'>('all');

  async function run(key: string, work: () => Promise<unknown>, success?: string): Promise<void> {
    setBusy(key);
    setMessage(null);
    try {
      await work();
      setBoard(await fetchHousekeepingBoard(hotelId));
      if (success !== undefined) setMessage({ tone: 'ok', text: success });
    } catch (caught) {
      setMessage({ tone: 'error', text: caught instanceof Error ? caught.message : 'That could not be done.' });
    } finally {
      setBusy(null);
    }
  }

  const rooms = board.rooms.filter((room) =>
    filter === 'dirty'
      ? room.status.endsWith('DIRTY')
      : filter === 'tasks'
        ? room.activeTasks.length > 0
        : true,
  );
  const dirtyCount = board.rooms.filter((room) => room.status.endsWith('DIRTY')).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {(['all', 'dirty', 'tasks'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setFilter(value);
              }}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs',
                filter === value ? 'border-white/25 bg-white/[0.06] text-zinc-100' : 'border-white/[0.08] text-zinc-400',
              )}
            >
              {value === 'all' ? `All rooms (${String(board.rooms.length)})` : value === 'dirty' ? `Dirty (${String(dirtyCount)})` : 'With open tasks'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              void run('refresh', () => Promise.resolve());
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-50"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            disabled={busy !== null || dirtyCount === 0}
            onClick={() => {
              void run('queue', async () => {
                const result = await queueHousekeepingCleaning(hotelId);
                setMessage({ tone: 'ok', text: `${String(result.created)} cleaning task(s) queued.` });
              });
            }}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <BrushCleaning className="size-3.5" aria-hidden="true" />
            Queue cleaning for dirty rooms
          </button>
        </div>
      </div>

      {message !== null ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            message.tone === 'error' ? 'border-rose-500/25 bg-rose-500/[0.07] text-rose-200' : 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-200',
          )}
        >
          {message.text}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rooms.map((room) => (
          <RoomCard key={room.roomId} room={room} board={board} busy={busy} run={run} hotelId={hotelId} />
        ))}
      </div>
      {rooms.length === 0 ? <p className="text-xs text-zinc-500">No rooms match.</p> : null}
    </div>
  );
}

function RoomCard({
  room,
  board,
  busy,
  run,
  hotelId,
}: {
  room: HousekeepingBoardRoom;
  board: HousekeepingBoard;
  busy: string | null;
  run: (key: string, work: () => Promise<unknown>, success?: string) => Promise<void>;
  hotelId: string;
}) {
  const [newType, setNewType] = useState<HousekeepingTaskView['type']>(room.status.endsWith('DIRTY') ? 'CLEAN' : 'INSPECTION');
  const [assignee, setAssignee] = useState('');

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-zinc-100">Room {room.number}</p>
          <p className="text-[11px] text-zinc-500">
            {room.roomTypeName}
            {room.floor === null ? '' : ` · floor ${room.floor}`}
          </p>
        </div>
        <span className={cn('rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase', STATUS_TONE[room.status] ?? STATUS_TONE['OUT_OF_SERVICE'])}>
          {label(room.status)}
        </span>
      </header>

      <div className="flex flex-wrap gap-1.5 text-[10px] text-zinc-400">
        {room.occupied ? (
          <span className="flex items-center gap-1"><User className="size-3" aria-hidden="true" />In house</span>
        ) : null}
        {room.departingToday ? (
          <span className="flex items-center gap-1 text-amber-300"><LogOut className="size-3" aria-hidden="true" />Departs today</span>
        ) : null}
        {room.arrivingToday ? (
          <span className="flex items-center gap-1 text-sky-300"><LogIn className="size-3" aria-hidden="true" />Arrival today</span>
        ) : null}
      </div>

      {room.activeTasks.map((task) => (
        <div key={task.id} className="flex flex-col gap-1.5 rounded-lg border border-white/[0.06] bg-black/20 p-2">
          <p className="text-xs text-zinc-200">
            {TASK_LABEL[task.type]} · <span className="text-zinc-400">{label(task.status)}</span>
          </p>
          <p className="text-[11px] text-zinc-500">{task.assignedTo === null ? 'Unassigned' : `Assigned to ${task.assignedTo.name}`}</p>
          {task.notes === null ? null : <p className="text-[11px] text-zinc-400">{task.notes}</p>}
          <div className="flex flex-wrap gap-1.5">
            {task.type === 'INSPECTION' ? (
              <>
                <TaskButton
                  icon={ClipboardCheck}
                  label="Pass"
                  disabled={busy !== null}
                  onClick={() => void run(task.id, () => actOnHousekeepingTask(hotelId, task.id, 'inspect', { result: 'PASSED', notes: null }), `Room ${room.number} passed inspection.`)}
                />
                <TaskButton
                  icon={ClipboardCheck}
                  label="Fail"
                  disabled={busy !== null}
                  onClick={() => void run(task.id, () => actOnHousekeepingTask(hotelId, task.id, 'inspect', { result: 'FAILED', notes: null }), `Room ${room.number} failed inspection; a re-clean is queued.`)}
                />
              </>
            ) : (
              <>
                {task.status === 'OPEN' ? (
                  <TaskButton icon={Play} label="Start" disabled={busy !== null} onClick={() => void run(task.id, () => actOnHousekeepingTask(hotelId, task.id, 'start'))} />
                ) : null}
                <TaskButton icon={Sparkles} label="Done" disabled={busy !== null} onClick={() => void run(task.id, () => actOnHousekeepingTask(hotelId, task.id, 'complete', { notes: null }), `${TASK_LABEL[task.type]} done in room ${room.number}.`)} />
              </>
            )}
            <select
              aria-label="Assign to"
              value={task.assignedTo?.id ?? ''}
              disabled={busy !== null}
              onChange={(event) => {
                const value = event.target.value === '' ? null : event.target.value;
                void run(task.id, () => actOnHousekeepingTask(hotelId, task.id, 'assign', { assignedToId: value }));
              }}
              className="h-7 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[11px] text-zinc-300"
            >
              <option value="" className="bg-zinc-900">Unassigned</option>
              {board.assignable.map((person) => (
                <option key={person.id} value={person.id} className="bg-zinc-900">{person.name}</option>
              ))}
            </select>
            <TaskButton icon={null} label="Cancel" disabled={busy !== null} onClick={() => void run(task.id, () => actOnHousekeepingTask(hotelId, task.id, 'cancel'))} />
          </div>
        </div>
      ))}

      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2">
        <select
          aria-label="Task type"
          value={newType}
          onChange={(event) => {
            setNewType(event.target.value as HousekeepingTaskView['type']);
          }}
          className="h-7 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[11px] text-zinc-300"
        >
          {Object.entries(TASK_LABEL).map(([value, text]) => (
            <option key={value} value={value} className="bg-zinc-900">{text}</option>
          ))}
        </select>
        <select
          aria-label="Assign new task to"
          value={assignee}
          onChange={(event) => {
            setAssignee(event.target.value);
          }}
          className="h-7 rounded-md border border-white/[0.08] bg-white/[0.03] px-1.5 text-[11px] text-zinc-300"
        >
          <option value="" className="bg-zinc-900">Unassigned</option>
          {board.assignable.map((person) => (
            <option key={person.id} value={person.id} className="bg-zinc-900">{person.name}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void run(`new-${room.roomId}`, () =>
              createHousekeepingTask(hotelId, { roomId: room.roomId, type: newType, assignedToId: assignee === '' ? null : assignee, notes: null }),
            `${TASK_LABEL[newType]} task added to room ${room.number}.`)
          }
          className="flex items-center gap-1 rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-zinc-200 disabled:opacity-50"
        >
          {busy === `new-${room.roomId}` ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
          Add task
        </button>
      </div>
    </section>
  );
}

function TaskButton({
  icon: Icon,
  label: text,
  disabled,
  onClick,
}: {
  icon: typeof Play | null;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/[0.04] disabled:opacity-50"
    >
      {Icon === null ? null : <Icon className="size-3" aria-hidden="true" />}
      {text}
    </button>
  );
}
