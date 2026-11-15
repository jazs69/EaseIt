/**
 * Seasonal and recurring pricing-rule endpoints (F3).
 *
 * ===========================================================================
 * TWO ROUTE FAMILIES, ONE SERVICE, ONE TABLE.
 *
 *   `/seasons`       — SEASONAL rules only.
 *   `/pricing-rules` — WEEKDAY and WEEKEND rules only.
 *
 * An operator's mental model separates "Christmas" from "Saturdays are
 * dearer", so the API does too. The storage does not, because the two differ
 * only in how they decide whether a night matches, and four tables would mean
 * two of every other thing.
 *
 * THE SPLIT IS ENFORCED, not conventional. Each handler passes its allowed
 * kinds down, and the service refuses a body of the wrong kind, hides a rule
 * of the wrong kind behind not-found, and will not let a `kind` query
 * parameter widen what the route family permits. So the seasons surface cannot
 * be used to read, write or address a weekday rule.
 *
 * `SessionAuthGuard` only, deliberately not `ActivePropertyGuard` -- these
 * routes are addressed by `:hotelId`, the operator-facing property code, while
 * that guard resolves a uuid. The grant is resolved in the service through
 * `grantedPropertyWhere`, as every other `:hotelId` route in this API does.
 *
 * Permissions: GET -> RATES_READ, everything else -> RATES_MANAGE. Both
 * already existed in `packages/types/src/rbac.ts` before F1; this scope adds
 * none.
 * ===========================================================================
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  createRatePricingRuleRequestSchema,
  listRatePricingRulesQuerySchema,
  ratePricingRuleStatusSchema,
  updateRatePricingRuleRequestSchema,
  type CreateRatePricingRuleRequest,
  type ListRatePricingRulesQuery,
  type RatePricingRuleListResponse,
  type RatePricingRuleStatusAction,
  type RatePricingRuleView,
  type UpdateRatePricingRuleRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  RECURRING_KINDS,
  RatePricingRuleService,
  SEASON_KINDS,
} from './rate-pricing-rule.service.js';

@ApiTags('rates')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class RatePricingRuleController {
  constructor(private readonly rules: RatePricingRuleService) {}

  /* -- Seasons ------------------------------------------------------------ */

  @Get(':hotelId/rate-plans/:ratePlanId/seasons')
  @ApiOperation({
    summary: 'The dated seasons configured for this rate plan',
    description:
      'Seasons are explicit date ranges, INCLUSIVE at both ends — "20 ' +
      'December through 10 January" covers both of those nights. A season ' +
      'crossing New Year is an ordinary range whose end sorts after its ' +
      'start; no wrap-around is involved. Returned in precedence order: ' +
      'higher priority first.',
  })
  @ApiOkResponse({ description: 'Seasons, each with its per-room-type prices.' })
  @ApiNotFoundResponse({ description: 'No such property or rate plan, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  listSeasons(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Query(new ZodValidationPipe(listRatePricingRulesQuerySchema))
    query: ListRatePricingRulesQuery,
  ): Promise<RatePricingRuleListResponse> {
    return this.rules.list(this.userId(request), hotelId, ratePlanId, query, SEASON_KINDS);
  }

  @Post(':hotelId/rate-plans/:ratePlanId/seasons')
  @ApiOperation({
    summary: 'Create a season',
    description:
      'Dates are inclusive. Every room type priced must already be assigned ' +
      'to the plan. A season that would collide with an existing enabled ' +
      'season — same priority, overlapping dates, and at least one room type ' +
      'in common — is REFUSED, because two such rules would give a night two ' +
      'prices with no deterministic way to choose. Raise one rule’s priority ' +
      'instead.',
  })
  @ApiCreatedResponse({ description: 'The created season.' })
  @ApiBadRequestResponse({
    description: 'Bad dates, unassigned room type, negative rate, or an ambiguous overlap.',
  })
  @ApiNotFoundResponse({ description: 'No such property or rate plan, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That name is taken, or the plan is archived or paused.' })
  createSeason(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(createRatePricingRuleRequestSchema))
    body: CreateRatePricingRuleRequest,
  ): Promise<RatePricingRuleView> {
    return this.rules.create(this.userId(request), hotelId, ratePlanId, body, SEASON_KINDS);
  }

  @Patch(':hotelId/rate-plans/:ratePlanId/seasons/:seasonId')
  @ApiOperation({
    summary: 'Edit a season',
    description:
      '`kind` is not editable — turning a season into a weekday rule is a ' +
      'different rule, not an edit. Status is not editable here either; it ' +
      'has its own endpoint, so an edit can never disable a season as a side ' +
      'effect. Supplying `prices` replaces the whole set, applied as a diff ' +
      'so an unchanged room type keeps its row.',
  })
  @ApiOkResponse({ description: 'The updated season.' })
  @ApiBadRequestResponse({
    description: 'Bad dates, unassigned room type, or an ambiguous overlap.',
  })
  @ApiNotFoundResponse({ description: 'No such property, plan or season, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That name is taken, or the plan is archived or paused.' })
  updateSeason(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('seasonId') seasonId: string,
    @Body(new ZodValidationPipe(updateRatePricingRuleRequestSchema))
    body: UpdateRatePricingRuleRequest,
  ): Promise<RatePricingRuleView> {
    return this.rules.update(
      this.userId(request),
      hotelId,
      ratePlanId,
      seasonId,
      body,
      SEASON_KINDS,
    );
  }

  @Patch(':hotelId/rate-plans/:ratePlanId/seasons/:seasonId/status')
  @ApiOperation({
    summary: 'Enable or disable a season',
    description:
      'ENABLING re-runs the conflict check: a season may have been disabled ' +
      'precisely because it collided with another, and switching it back on ' +
      'must not resurrect an ambiguity. Disabling never conflicts. A no-op ' +
      'transition is refused rather than silently succeeding.',
  })
  @ApiOkResponse({ description: 'The season in its new state.' })
  @ApiBadRequestResponse({ description: 'Enabling would create an ambiguous overlap.' })
  @ApiNotFoundResponse({ description: 'No such property, plan or season, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'Already in that state, or the plan is archived or paused.' })
  setSeasonStatus(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('seasonId') seasonId: string,
    @Body(new ZodValidationPipe(ratePricingRuleStatusSchema))
    body: RatePricingRuleStatusAction,
  ): Promise<RatePricingRuleView> {
    return this.rules.setStatus(
      this.userId(request),
      hotelId,
      ratePlanId,
      seasonId,
      body,
      SEASON_KINDS,
    );
  }

  /**
   * `204`, because a successful delete has nothing to return and a body would
   * invite a client to believe something survived.
   */
  @Delete(':hotelId/rate-plans/:ratePlanId/seasons/:seasonId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a season',
    description:
      'A real delete, unlike a rate plan, which only archives: a pricing ' +
      'rule is pure configuration and nothing references it — no reservation ' +
      'or folio points at one, because pricing integration is F9. Deleting ' +
      'changes future effective rates and nothing else. Explicit F2 date ' +
      'overrides are NOT touched and continue to apply.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ description: 'No such property, plan or season, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'The plan is archived or paused.' })
  deleteSeason(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('seasonId') seasonId: string,
  ): Promise<void> {
    return this.rules.remove(this.userId(request), hotelId, ratePlanId, seasonId, SEASON_KINDS);
  }

  /* -- Recurring weekday and weekend rules -------------------------------- */

  @Get(':hotelId/rate-plans/:ratePlanId/pricing-rules')
  @ApiOperation({
    summary: 'The recurring weekday and weekend rules for this rate plan',
    description:
      'A WEEKDAY rule names its own days (0 = Sunday … 6 = Saturday). A ' +
      'WEEKEND rule uses the property’s configured weekend, returned as ' +
      '`weekendDays` so the UI can label it with what it actually means here ' +
      'rather than assuming Saturday and Sunday. WEEKDAY outranks WEEKEND: ' +
      'naming a day explicitly is more specific than deferring to the ' +
      'property definition.',
  })
  @ApiOkResponse({ description: 'Rules, each with its per-room-type prices.' })
  @ApiNotFoundResponse({ description: 'No such property or rate plan, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  listRules(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Query(new ZodValidationPipe(listRatePricingRulesQuerySchema))
    query: ListRatePricingRulesQuery,
  ): Promise<RatePricingRuleListResponse> {
    return this.rules.list(this.userId(request), hotelId, ratePlanId, query, RECURRING_KINDS);
  }

  @Post(':hotelId/rate-plans/:ratePlanId/pricing-rules')
  @ApiOperation({
    summary: 'Create a weekday or weekend rule',
    description:
      'A WEEKDAY rule requires `daysOfWeek` and carries no dates; a WEEKEND ' +
      'rule carries neither, because its days come from the property. Two ' +
      'rules of the same kind at the same priority sharing a day and a room ' +
      'type are REFUSED — and two WEEKEND rules at the same priority always ' +
      'collide, since they match the same nights by definition.',
  })
  @ApiCreatedResponse({ description: 'The created rule.' })
  @ApiBadRequestResponse({
    description: 'Wrong fields for the kind, unassigned room type, or an ambiguous overlap.',
  })
  @ApiNotFoundResponse({ description: 'No such property or rate plan, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That name is taken, or the plan is archived or paused.' })
  createRule(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Body(new ZodValidationPipe(createRatePricingRuleRequestSchema))
    body: CreateRatePricingRuleRequest,
  ): Promise<RatePricingRuleView> {
    return this.rules.create(this.userId(request), hotelId, ratePlanId, body, RECURRING_KINDS);
  }

  @Patch(':hotelId/rate-plans/:ratePlanId/pricing-rules/:ruleId')
  @ApiOperation({
    summary: 'Edit a weekday or weekend rule',
    description:
      '`kind` is not editable. Clearing every day from a WEEKDAY rule is ' +
      'refused with a field name rather than reaching the database CHECK as ' +
      'an opaque constraint violation: the merged state is validated, not ' +
      'just the patch.',
  })
  @ApiOkResponse({ description: 'The updated rule.' })
  @ApiBadRequestResponse({ description: 'Wrong fields for the kind, or an ambiguous overlap.' })
  @ApiNotFoundResponse({ description: 'No such property, plan or rule, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That name is taken, or the plan is archived or paused.' })
  updateRule(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('ruleId') ruleId: string,
    @Body(new ZodValidationPipe(updateRatePricingRuleRequestSchema))
    body: UpdateRatePricingRuleRequest,
  ): Promise<RatePricingRuleView> {
    return this.rules.update(
      this.userId(request),
      hotelId,
      ratePlanId,
      ruleId,
      body,
      RECURRING_KINDS,
    );
  }

  @Patch(':hotelId/rate-plans/:ratePlanId/pricing-rules/:ruleId/status')
  @ApiOperation({
    summary: 'Enable or disable a weekday or weekend rule',
    description: 'Enabling re-runs the conflict check, exactly as it does for a season.',
  })
  @ApiOkResponse({ description: 'The rule in its new state.' })
  @ApiBadRequestResponse({ description: 'Enabling would create an ambiguous overlap.' })
  @ApiNotFoundResponse({ description: 'No such property, plan or rule, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'Already in that state, or the plan is archived or paused.' })
  setRuleStatus(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('ruleId') ruleId: string,
    @Body(new ZodValidationPipe(ratePricingRuleStatusSchema))
    body: RatePricingRuleStatusAction,
  ): Promise<RatePricingRuleView> {
    return this.rules.setStatus(
      this.userId(request),
      hotelId,
      ratePlanId,
      ruleId,
      body,
      RECURRING_KINDS,
    );
  }

  @Delete(':hotelId/rate-plans/:ratePlanId/pricing-rules/:ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a weekday or weekend rule',
    description: 'Explicit F2 date overrides are not touched and continue to apply.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ description: 'No such property, plan or rule, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'The plan is archived or paused.' })
  deleteRule(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('ratePlanId') ratePlanId: string,
    @Param('ruleId') ruleId: string,
  ): Promise<void> {
    return this.rules.remove(this.userId(request), hotelId, ratePlanId, ruleId, RECURRING_KINDS);
  }

  /** Unreachable while `SessionAuthGuard` is attached; asserted so that
   *  detaching it fails closed rather than reading a property of `undefined`. */
  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
