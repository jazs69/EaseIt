/**
 * Rate-plan configuration endpoints (scope F1).
 *
 * `SessionAuthGuard` only, deliberately not `ActivePropertyGuard` -- these
 * routes are addressed by `:hotelId`, the operator-facing property code, while
 * that guard resolves a uuid. The grant is resolved in the service through
 * `grantedPropertyWhere`, as every other `:hotelId` route in this API does.
 *
 * Permissions:
 *   GET    -> RATES_READ
 *   POST   -> RATES_MANAGE
 *   PATCH  -> RATES_MANAGE
 *   status -> RATES_MANAGE
 *
 * Both already exist in `packages/types/src/rbac.ts` and are already granted
 * by the seeded role templates -- `RATES_READ` to front desk, both to the
 * revenue manager. This scope makes them load-bearing; it does not add them.
 *
 * There is no DELETE route, and that is a design decision rather than an
 * omission. See `rate-plan.service.ts`.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  clearRateCalendarRequestSchema,
  createRatePlanRequestSchema,
  listRatePlansQuerySchema,
  rateCalendarQuerySchema,
  ratePlanStatusActionSchema,
  updateRateCalendarRequestSchema,
  updateRatePlanRequestSchema,
  updateRatePlanRoomTypeRequestSchema,
  type ClearRateCalendarRequest,
  type CreateRatePlanRequest,
  type ListRatePlansQuery,
  type RateCalendarQuery,
  type RateCalendarResponse,
  type RateCalendarWriteResult,
  type RatePlanListResponse,
  type RatePlanStatusAction,
  type RatePlanView,
  type UpdateRateCalendarRequest,
  type UpdateRatePlanRequest,
  type UpdateRatePlanRoomTypeRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { RateCalendarService } from './rate-calendar.service.js';
import { RatePlanService } from './rate-plan.service.js';

@ApiTags('rates')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RatePlanController {
  constructor(
    private readonly ratePlans: RatePlanService,
    private readonly calendar: RateCalendarService,
  ) {}

  @Get(':hotelId/rate-plans')
  @ApiOperation({
    summary: 'The rate plans this property has configured',
    description:
      'Defaults to active plans only. `status=archived` is a separate filter ' +
      'rather than part of `inactive`, because an archived plan is inactive by ' +
      'construction and folding the two would bury the paused plans an ' +
      'operator is actually looking for. The response echoes the property’s ' +
      'currency once, which is what a rate input needs and what the client is ' +
      'never allowed to choose.',
  })
  @ApiOkResponse({ description: 'Matching rate plans, by sort order then code.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(listRatePlansQuerySchema))
    query: ListRatePlansQuery,
  ): Promise<RatePlanListResponse> {
    return this.ratePlans.list(this.userId(request), hotelId, query);
  }

  @Get(':hotelId/rate-plans/:ratePlanId')
  @ApiOperation({
    summary: 'One rate plan in full',
    description:
      'Includes every assigned room type. Scoped by `propertyId` in the same ' +
      'predicate as the id, so another property’s plan is not found rather ' +
      'than forbidden (CLAUDE.md section 3.2).',
  })
  @ApiOkResponse({ description: 'The rate plan.' })
  @ApiNotFoundResponse({ description: 'No such property or rate plan, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  detail(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
  ): Promise<RatePlanView> {
    return this.ratePlans.detail(this.userId(request), hotelId, ratePlanId);
  }

  @Post(':hotelId/rate-plans')
  @ApiOperation({
    summary: 'Create a rate plan',
    description:
      'The plan carries one nightly rate and the room types it applies to. ' +
      'Per-date pricing, restrictions and derived rates are later scopes; the ' +
      'rate here is what a date with no calendar row will fall back to. ' +
      'Currency is NOT settable — it is the property’s own. Nothing prices ' +
      'from a rate plan yet: the booking path still reads the room type’s ' +
      'rack rate, so creating a plan changes no quote.',
  })
  @ApiCreatedResponse({ description: 'The created rate plan.' })
  @ApiBadRequestResponse({ description: 'A room type is not this property’s, or bad money.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That code or name is already in use here.' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createRatePlanRequestSchema))
    body: CreateRatePlanRequest,
  ): Promise<RatePlanView> {
    return this.ratePlans.create(this.userId(request), hotelId, body);
  }

  @Patch(':hotelId/rate-plans/:ratePlanId')
  @ApiOperation({
    summary: 'Edit a rate plan',
    description:
      '`code` is not editable: it is the operator-facing identity quoted in ' +
      'reports and the thing a future channel mapping points at, so renaming ' +
      'it would orphan those references. Status is not editable here either — ' +
      'it has its own endpoint, so an edit can never stop a plan selling as a ' +
      'side effect. Supplying `roomTypeIds` REPLACES the whole assignment.',
  })
  @ApiOkResponse({ description: 'The updated rate plan.' })
  @ApiBadRequestResponse({ description: 'A room type is not this property’s, or bad money.' })
  @ApiNotFoundResponse({ description: 'No such property or rate plan, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({
    description: 'That name is already in use here, or the plan is archived.',
  })
  update(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(updateRatePlanRequestSchema))
    body: UpdateRatePlanRequest,
  ): Promise<RatePlanView> {
    return this.ratePlans.update(this.userId(request), hotelId, ratePlanId, body);
  }

  /**
   * `@HttpCode(OK)` because this is a state transition on an existing plan,
   * not a creation — the same reason `cancel`, `check-out` and the inventory
   * horizon POST carry it. Without it Nest answers 201 for a POST, which would
   * claim a resource was created.
   */
  @Post(':hotelId/rate-plans/:ratePlanId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate, deactivate or archive a rate plan',
    description:
      'A no-op transition is refused rather than silently succeeding, so an ' +
      'operator who activates an already-active plan is told why nothing ' +
      'changed. ARCHIVE is terminal and also deactivates — the database ' +
      'asserts that pair. There is no UNARCHIVE and no delete: a plan that ' +
      'might come back should be deactivated, and a plan that has ever been ' +
      'quoted is history.',
  })
  @ApiOkResponse({ description: 'The rate plan in its new state.' })
  @ApiNotFoundResponse({ description: 'No such property or rate plan, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That transition is not legal from the current state.' })
  setStatus(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(ratePlanStatusActionSchema))
    body: RatePlanStatusAction,
  ): Promise<RatePlanView> {
    return this.ratePlans.setStatus(this.userId(request), hotelId, ratePlanId, body);
  }

  /* -- F2: per-room-type default rate ------------------------------------- */

  @Patch(':hotelId/rate-plans/:ratePlanId/room-types/:roomTypeId')
  @ApiOperation({
    summary: "Update one room type's default rate within a plan",
    description:
      'A dedicated endpoint, because the operator action is "Deluxe is now ' +
      '2,900" and nothing else should be at risk. It does NOT touch date-wise ' +
      'overrides: the default is the fallback for nights that have no ' +
      'override, so every deliberately-priced night survives unchanged. The ' +
      'room type must already be assigned to the plan — adding or removing an ' +
      'assignment is the plan PATCH.',
  })
  @ApiOkResponse({ description: 'The plan, with the repriced assignment.' })
  @ApiBadRequestResponse({ description: 'Wrong currency, or bad money.' })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'The plan is archived.' })
  updateRoomTypeRate(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('roomTypeId') roomTypeId: string,
    @Body(new ZodValidationPipe(updateRatePlanRoomTypeRequestSchema))
    body: UpdateRatePlanRoomTypeRequest,
  ): Promise<RatePlanView> {
    return this.ratePlans.updateRoomTypeRate(
      this.userId(request),
      hotelId,
      ratePlanId,
      roomTypeId,
      body,
    );
  }

  /* -- F2: the date-wise calendar ----------------------------------------- */

  @Get(':hotelId/rate-plans/:ratePlanId/calendar')
  @ApiOperation({
    summary: 'The date-wise rate calendar for one room type under one plan',
    description:
      'Returns EVERY requested date, including nights with no override — a ' +
      'sparse response would make the client reconstruct the gaps, and a ' +
      'client that got that wrong would render a blank cell as "unpriced" ' +
      'rather than "default". Each day carries the default, the override (or ' +
      'null) and the effective rate, so an operator can see both that a night ' +
      'differs and what it would otherwise be. The room type must be assigned ' +
      'to the plan.',
  })
  @ApiOkResponse({ description: 'The window, one entry per date.' })
  @ApiBadRequestResponse({ description: 'Bad dates, inverted range, or too wide.' })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  readCalendar(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Query(new ZodValidationPipe(rateCalendarQuerySchema))
    query: RateCalendarQuery,
  ): Promise<RateCalendarResponse> {
    return this.calendar.read(this.userId(request), hotelId, ratePlanId, query);
  }

  /**
   * `PUT`, because the listed dates are *set* to the given amounts — sending
   * it twice leaves the same state, which is what distinguishes it from a
   * POST. Dates NOT listed are untouched, so this is not a replace of the
   * whole calendar.
   */
  @Put(':hotelId/rate-plans/:ratePlanId/calendar')
  @ApiOperation({
    summary: 'Set the nightly rate for a list of dates (bulk)',
    description:
      'Upserts exactly the dates supplied, in ONE statement, so Postgres ' +
      'applies all of them or none. Dates not listed are left alone — this is ' +
      'not a whole-calendar replace. The entire request is validated before ' +
      'anything is written. Duplicate dates are refused rather than ' +
      'last-one-wins. An inactive or archived plan cannot be repriced.',
  })
  @ApiOkResponse({ description: 'Counts of created and updated dates, plus the refreshed window.' })
  @ApiBadRequestResponse({ description: 'Bad dates, duplicates, or negative money.' })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'The plan is inactive or archived.' })
  updateCalendar(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(updateRateCalendarRequestSchema))
    body: UpdateRateCalendarRequest,
  ): Promise<RateCalendarWriteResult> {
    return this.calendar.update(this.userId(request), hotelId, ratePlanId, body);
  }

  /**
   * `@HttpCode(OK)` because this removes rows rather than creating a resource,
   * and a POST would otherwise answer 201. Modelled as a POST rather than a
   * DELETE because it carries a body — a list of dates — and DELETE bodies are
   * poorly supported by intermediaries.
   */
  @Post(':hotelId/rate-plans/:ratePlanId/calendar/clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear the overrides for a list of dates',
    description:
      'Deletes the override rows so those nights fall back to the ' +
      "assignment's default. The default itself is NOT deleted or changed. " +
      'Clearing a date that has no override is not an error — the requested ' +
      'end state is reached either way, and refusing would make "clear this ' +
      'selection" fail whenever one day in it was already at the default.',
  })
  @ApiOkResponse({ description: 'How many overrides went, plus the refreshed window.' })
  @ApiBadRequestResponse({ description: 'Bad dates or duplicates.' })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'The plan is inactive or archived.' })
  clearCalendar(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(clearRateCalendarRequestSchema))
    body: ClearRateCalendarRequest,
  ): Promise<RateCalendarWriteResult> {
    return this.calendar.clear(this.userId(request), hotelId, ratePlanId, body);
  }

  /** Unreachable while `SessionAuthGuard` is attached; asserted so that
   *  detaching it fails closed rather than reading a property of `undefined`. */
  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
