import type { Metadata } from 'next';
import { Wrench } from 'lucide-react';

import { PlaceholderScreen } from '@/components/dashboard/placeholder-screen';
import { MaintenanceScreen } from '@/components/maintenance/maintenance-screen';
import { ApiRequestError } from '@/lib/api';
import { fetchHousekeepingBoard, fetchWorkOrders } from '@/lib/properties-client';
import { requireHotelId } from '@/lib/property-route';
import { requireSession } from '@/lib/server-session';

export const metadata: Metadata = {
  title: 'Maintenance',
  description: 'Work orders: faults on rooms, and rooms taken out of order to fix them.',
  robots: { index: false, follow: false },
};

// Per-property, like every screen in this shell.
export const dynamic = 'force-dynamic';

/**
 * Maintenance, at `/maintenance?hotelId=31336` (MA-01).
 *
 * Reading and reporting need `housekeeping:read`; the room list comes from
 * the housekeeping board, which the same permission reads. Managing orders
 * needs `maintenance:manage`, and taking a room out of order also
 * `room_blocks:manage`; the server enforces all three.
 */
export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hotelId = requireHotelId(params);
  const { session, cookieHeader } = await requireSession();

  let orders;
  let board;
  try {
    [orders, board] = await Promise.all([
      fetchWorkOrders(hotelId, 'active', { cookieHeader }),
      fetchHousekeepingBoard(hotelId, { cookieHeader }),
    ]);
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.status === 403) {
      return (
        <main className="mx-auto flex w-full max-w-5xl flex-col px-4 py-8 sm:px-6">
          <PlaceholderScreen
            icon={Wrench}
            title="Maintenance"
            summary="Work orders: faults on rooms, and rooms taken out of order to fix them."
            blockedBy="Your role at this property does not include the housekeeping board (housekeeping:read)."
          />
        </main>
      );
    }
    throw cause;
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
        <p className="text-sm text-muted-foreground">
          Faults reported on rooms, who is fixing them, and rooms out of order meanwhile.
        </p>
      </header>
      <MaintenanceScreen
        hotelId={hotelId}
        initial={orders}
        rooms={board.rooms.map((room) => ({
          roomId: room.roomId,
          number: room.number,
          roomTypeName: room.roomTypeName,
          occupied: room.occupied,
        }))}
        canManage={session.permissions.includes('maintenance:manage')}
        canBlock={session.permissions.includes('room_blocks:manage')}
      />
    </main>
  );
}
