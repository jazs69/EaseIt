/**
 * Maintenance work orders (MA-01). Taking a room out of order is a room block,
 * created through the inventory module's RoomBlockService in the work
 * order's own transaction.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { WorkOrdersController } from './work-orders.controller.js';
import { WorkOrdersService } from './work-orders.service.js';

@Module({
  imports: [InventoryModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, TokenService, SessionAuthGuard],
})
export class MaintenanceModule {}
