/**
 * The `frontdesk` module (CLAUDE.md section 2): the arrivals / departures
 * board (FD-09). Check-in, check-out and room moves still live in
 * `reservations`, which owns every write to a stay; this module only reads.
 */

import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { FrontDeskBoardController } from './front-desk-board.controller.js';
import { FrontDeskBoardService } from './front-desk-board.service.js';

@Module({
  controllers: [FrontDeskBoardController],
  providers: [FrontDeskBoardService, TokenService, SessionAuthGuard],
})
export class FrontDeskModule {}
