/**
 * Room configuration and housekeeping status, for one property.
 *
 * ===========================================================================
 * WHAT THIS SCREEN DELIBERATELY DOES NOT SHOW.
 *
 * No Blocked badge, no Available / Bookable / Free column, and no room-block
 * controls. Whether a room is withheld from sale lives in `room_block`, which
 * has no read endpoint in this release -- so the screen cannot know, and a
 * column that rendered an empty or false value would read as "not blocked"
 * rather than as "unknown". The banner says so out loud instead, because an
 * omission a user cannot see is indistinguishable from a claim.
 *
 * There is also no affordance pointing at a room-block workflow, for the same
 * reason: directing an operator to a feature they cannot reach is worse than
 * saying less.
 *
 * `roomCount` versus the calendar's `physical` is surfaced on purpose. A room
 * added today does not change capacity on nights that already exist, because
 * `physical` is computed once when a night is generated and never recomputed.
 * Showing the live count here is what makes that visible rather than silent.
 * ===========================================================================
 */

import { BedDouble, Info, Layers } from 'lucide-react';
import type { RoomListResponse, RoomTypeListResponse } from '@repo/types';

import { Badge } from '@repo/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';

/** Human labels for the housekeeping states. */
const STATUS_LABELS: Record<string, string> = {
  VACANT_CLEAN: 'Vacant, clean',
  VACANT_DIRTY: 'Vacant, dirty',
  INSPECTED: 'Inspected',
  OCCUPIED_CLEAN: 'Occupied, clean',
  OCCUPIED_DIRTY: 'Occupied, dirty',
  OUT_OF_SERVICE: 'Out of service',
  OUT_OF_ORDER: 'Out of order',
};

/**
 * Tone per status. `OUT_OF_SERVICE` and `OUT_OF_ORDER` are marked distinctly
 * because both behave unusually: out-of-service rooms are still counted as
 * sellable stock yet cannot be checked into, and out-of-order rooms are not
 * counted at all.
 */
function statusTone(
  status: string,
): 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' {
  // Not counted as sellable stock at all.
  if (status === 'OUT_OF_ORDER') return 'destructive';
  // Counted as stock and still sellable, yet check-in is refused — which is
  // why it can no longer be set, only cleared.
  if (status === 'OUT_OF_SERVICE') return 'warning';
  if (status === 'OCCUPIED_CLEAN' || status === 'OCCUPIED_DIRTY') return 'default';
  if (status === 'VACANT_DIRTY') return 'secondary';
  return 'outline';
}

function formatRate(amountMinor: number, currency: string): string {
  // Integer minor units in, formatted once for display. No arithmetic is done
  // on this value anywhere in the UI (CLAUDE.md section 3.4).
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(amountMinor / 100);
}

export function RoomsScreen({
  roomTypes,
  rooms,
}: {
  roomTypes: RoomTypeListResponse;
  rooms: RoomListResponse;
}) {
  return (
    <div className="flex w-full flex-col gap-6">
      <AvailabilityNotice />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <RoomTypePane roomTypes={roomTypes} />
        <RoomPane rooms={rooms} />
      </div>
    </div>
  );
}

/**
 * The standing banner.
 *
 * Not dismissible, and not styled as an error: it states a scope boundary that
 * holds for the whole release, not a fault.
 */
function AvailabilityNotice() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="text-muted-foreground">
        This screen shows room configuration and housekeeping status only. It does{' '}
        <strong className="font-medium text-foreground">not</strong> show whether a room is blocked
        or available — room blocks are not yet available in this release.
      </p>
    </div>
  );
}

function RoomTypePane({ roomTypes }: { roomTypes: RoomTypeListResponse }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <Layers className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle className="text-base">Categories</CardTitle>
        <span className="ml-auto text-sm text-muted-foreground">{roomTypes.items.length}</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {roomTypes.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No room types yet. A property needs at least one category before it can sell anything.
          </p>
        ) : (
          roomTypes.items.map((type) => (
            <div key={type.id} className="flex flex-col gap-1 rounded-md border border-border p-3">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-muted-foreground">{type.code}</span>
                <span className="truncate font-medium">{type.name}</span>
              </div>
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <div className="flex gap-1">
                  <dt>Rooms</dt>
                  <dd className="font-medium text-foreground">{type.roomCount}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>Sleeps</dt>
                  <dd className="font-medium text-foreground">
                    {type.maxGuests}
                    {type.maxAdults === null ? '' : ` (${String(type.maxAdults)} adults)`}
                  </dd>
                </div>
                <div className="flex gap-1">
                  <dt>Rack</dt>
                  <dd className="font-medium text-foreground">
                    {formatRate(type.baseRate.amountMinor, type.baseRate.currency)}
                  </dd>
                </div>
              </dl>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function RoomPane({ rooms }: { rooms: RoomListResponse }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2">
        <BedDouble className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle className="text-base">Rooms</CardTitle>
        <span className="ml-auto text-sm text-muted-foreground">
          {rooms.items.length}
          {rooms.nextCursor === null ? '' : '+'}
        </span>
      </CardHeader>
      <CardContent>
        {rooms.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rooms yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs tracking-wide text-muted-foreground uppercase">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Room
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Floor
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Category
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Housekeeping
                  </th>
                </tr>
              </thead>
              <tbody>
                {rooms.items.map((room) => (
                  <tr key={room.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-4 font-medium">{room.number}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{room.floor ?? '—'}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      <span className="font-mono text-xs">{room.roomTypeCode}</span>{' '}
                      {room.roomTypeName}
                    </td>
                    <td className="py-2">
                      <Badge variant={statusTone(room.status)}>
                        {STATUS_LABELS[room.status] ?? room.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {rooms.nextCursor === null ? null : (
              <p className="pt-3 text-xs text-muted-foreground">
                Showing the first {rooms.items.length} rooms by number.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
