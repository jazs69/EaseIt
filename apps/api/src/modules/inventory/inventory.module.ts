import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryHorizonRepository } from './inventory-horizon.repository.js';
import { InventoryHorizonService } from './inventory-horizon.service.js';

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
 */
@Module({
  controllers: [InventoryController],
  providers: [InventoryHorizonService, InventoryHorizonRepository, TokenService, SessionAuthGuard],
  exports: [InventoryHorizonService],
})
export class InventoryModule {}
