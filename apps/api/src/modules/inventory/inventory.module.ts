import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryDayRepository } from './inventory-day.repository.js';
import { InventoryDayService } from './inventory-day.service.js';
import { InventoryHorizonRepository } from './inventory-horizon.repository.js';
import { InventoryHorizonService } from './inventory-horizon.service.js';
import { RetirementRepository } from './retirement.repository.js';
import { RetirementService } from './retirement.service.js';
import { RoomBlockController } from './room-block.controller.js';
import { RoomBlockRepository } from './room-block.repository.js';
import { RoomBlockService } from './room-block.service.js';
import { RoomController } from './room.controller.js';
import { RoomRepository } from './room.repository.js';
import { RoomService } from './room.service.js';
import { RoomTypeController } from './room-type.controller.js';
import { RoomTypeRepository } from './room-type.repository.js';
import { RoomTypeService } from './room-type.service.js';

/**
 * The per-date availability calendar.
 *
 * CLAUDE.md section 2 gives the `inventory` module ownership of "room types,
 * rooms, per-date availability calendar, restrictions". Day 2 implements only
 * the calendar's *extent*: how far ahead rows exist, and an operator action to
 * push that further out. Room types, rooms and restrictions stay where they
 * are for now.
 *
 * It deliberately does **not** depend on `ReservationsModule`, and nothing in
 * reservations depends on this. The three reservation writers keep their own
 * `inventory_day` transactions exactly as they are; this module only ever
 * inserts nights that did not exist, which no reservation invariant depends on
 * being absent. Keeping the two apart is what stops the booking path acquiring
 * a reason to generate inventory inside its own transaction, which would put
 * an unbounded insert inside the lock protocol of CLAUDE.md section 3.1.1.
 *
 * `ClockService` arrives from the global `PlatformModule`, as it does in
 * `calendar` and `performance`: today must be the property's own calendar
 * date, never the server's (section 3.3).
 *
 * ---------------------------------------------------------------------------
 * Room types and rooms now live here too, which is where CLAUDE.md section 2
 * puts them. They are separate controllers rather than more routes on
 * `InventoryController`, because they address different resources and that
 * controller owns the calendar's extent.
 *
 * NEITHER writes `inventory_day`. Creating a room does not change `physical`
 * on nights that already exist, and the only status that changes physical
 * eligibility -- OUT_OF_ORDER -- cannot be set through the status endpoint. So
 * the five existing `inventory_day` writers keep their lock protocol
 * untouched, and nothing here enters it.
 *
 * Room BLOCKS are not wired: their schema, DTOs and pure policy exist, but the
 * endpoints belong to a later increment that is blocked on a measured
 * transaction timeout.
 * ---------------------------------------------------------------------------
 */
@Module({
  controllers: [InventoryController, RoomTypeController, RoomController, RoomBlockController],
  providers: [
    InventoryHorizonService,
    InventoryHorizonRepository,
    InventoryDayService,
    InventoryDayRepository,
    RoomTypeService,
    RoomTypeRepository,
    RoomService,
    RoomRepository,
    RoomBlockService,
    RetirementService,
    RetirementRepository,
    RoomBlockRepository,
    TokenService,
    SessionAuthGuard,
  ],
  exports: [InventoryHorizonService],
})
export class InventoryModule {}
