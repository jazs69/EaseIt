/**
 * Promotion, promo-code and discount-preview endpoints (F5).
 *
 * ===========================================================================
 * `SessionAuthGuard` only, deliberately not `ActivePropertyGuard` -- these
 * routes are addressed by `:hotelId`, the operator-facing property code, while
 * that guard resolves a uuid. The grant is resolved in the service through
 * `grantedPropertyWhere`, as every other `:hotelId` route in this API does.
 *
 * Permissions: GET and the preview -> RATES_READ; every mutation ->
 * RATES_MANAGE. The preview is a read because it mutates nothing and consumes
 * no redemption, consistent with F4's preview and with every other
 * non-mutating endpoint in this module. `RATES_READ` and `RATES_MANAGE` both
 * predate F1; F5 adds no permission.
 *
 * ROUTE ORDER MATTERS HERE. `preview` is declared BEFORE
 * `:promotionId`, because Fastify matches in declaration order and
 * `/promotions/preview` would otherwise be captured by `/promotions/:promotionId`
 * with `promotionId = "preview"` -- which would answer 404 for a valid
 * request. Static segments first is the rule.
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
  createPromoCodeRequestSchema,
  createPromotionRequestSchema,
  listPromotionsQuerySchema,
  previewPromotionRequestSchema,
  promoCodeStatusSchema,
  promotionStatusSchema,
  updatePromotionRequestSchema,
  type CreatePromoCodeRequest,
  type CreatePromotionRequest,
  type ListPromotionsQuery,
  type PreviewPromotionRequest,
  type PromoCodeListResponse,
  type PromoCodeStatusAction,
  type PromoCodeView,
  type PromotionListResponse,
  type PromotionPreview,
  type PromotionStatusAction,
  type PromotionView,
  type UpdatePromotionRequest,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PromotionService } from './promotion.service.js';

@ApiTags('rates')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class PromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @Get(':hotelId/promotions')
  @ApiOperation({
    summary: 'The promotions configured for this property',
    description:
      'Returned in precedence order — higher priority first — because that is ' +
      'the order the selector considers them in. Promotions do not stack: at ' +
      'most one applies to a night.',
  })
  @ApiOkResponse({ description: 'Promotions, each with its applicability and usage.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  list(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Query(new ZodValidationPipe(listPromotionsQuerySchema))
    query: ListPromotionsQuery,
  ): Promise<PromotionListResponse> {
    return this.promotions.list(this.userId(request), hotelId, query);
  }

  /**
   * Declared BEFORE `:promotionId`. Fastify matches in declaration order, so
   * the static `preview` segment must come first or it is swallowed by the
   * parameterised route.
   */
  @Post(':hotelId/promotions/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Price a stay and show which promotion applies (read-only)',
    description:
      'READ-ONLY. It consumes no redemption, moves no counter, writes no ' +
      'reservation, folio or inventory row, and records no audit event. ' +
      'Reservation pricing stays on its existing path until F9. The base rate ' +
      'comes from the SAME F2/F3 resolver the calendar uses and the occupancy ' +
      'charges from the SAME F4 calculator, both carried through unchanged; ' +
      'F5 only discounts the result. Returns every candidate promotion with ' +
      'the reason it did or did not qualify, the one selected, and a per-night ' +
      'breakdown. All amounts are PRE-TAX — tax is applied downstream at folio ' +
      'posting. `bookingDate` is required and never guessed: the booking ' +
      'window is part of eligibility.',
  })
  @ApiOkResponse({ description: 'Per-night and stay totals, candidates and the selection.' })
  @ApiBadRequestResponse({
    description: 'Bad dates, a stay beyond the preview limit, or an implausible total.',
  })
  @ApiNotFoundResponse({
    description: 'No such property, plan or assignment, or no grant.',
  })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  preview(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(previewPromotionRequestSchema))
    body: PreviewPromotionRequest,
  ): Promise<PromotionPreview> {
    return this.promotions.preview(this.userId(request), hotelId, body);
  }

  @Post(':hotelId/promotions')
  @ApiOperation({
    summary: 'Create a promotion',
    description:
      'Applicability is EXPLICIT: set `appliesToAllRatePlans` / ' +
      '`appliesToAllRoomTypes`, or list ids. A promotion naming neither can ' +
      'never apply and is refused — an empty list never silently means "all". ' +
      'Every room type named must be assigned to a rate plan the promotion ' +
      'also names, and an archived plan cannot be chosen. A promotion that ' +
      'would tie with an existing active one — same priority, overlapping ' +
      'dates, overlapping plans AND room types — is REFUSED, because two ' +
      'qualifying promotions at one priority would give a night two prices.',
  })
  @ApiCreatedResponse({ description: 'The created promotion.' })
  @ApiBadRequestResponse({
    description: 'Applies to nothing, an unassigned room type, or an ambiguous overlap.',
  })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That name is already in use here.' })
  create(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createPromotionRequestSchema))
    body: CreatePromotionRequest,
  ): Promise<PromotionView> {
    return this.promotions.create(this.userId(request), hotelId, body);
  }

  @Get(':hotelId/promotions/:promotionId')
  @ApiOperation({ summary: 'One promotion in full' })
  @ApiOkResponse({ description: 'The promotion.' })
  @ApiNotFoundResponse({ description: 'No such property or promotion, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  detail(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
  ): Promise<PromotionView> {
    return this.promotions.detail(this.userId(request), hotelId, promotionId);
  }

  @Patch(':hotelId/promotions/:promotionId')
  @ApiOperation({
    summary: 'Edit a promotion',
    description:
      'A patch, validated against the MERGED state: changing only a flag, or ' +
      'only a list, can still produce "applies to nothing" or a new overlap. ' +
      'Status is not editable here — it has its own endpoint, so an edit can ' +
      'never deactivate a promotion as a side effect. Redemption counters are ' +
      'server state and are not accepted.',
  })
  @ApiOkResponse({ description: 'The updated promotion.' })
  @ApiBadRequestResponse({ description: 'Applies to nothing, or an ambiguous overlap.' })
  @ApiNotFoundResponse({ description: 'No such property or promotion, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That name is already in use here.' })
  update(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
    @Body(new ZodValidationPipe(updatePromotionRequestSchema))
    body: UpdatePromotionRequest,
  ): Promise<PromotionView> {
    return this.promotions.update(this.userId(request), hotelId, promotionId, body);
  }

  @Patch(':hotelId/promotions/:promotionId/status')
  @ApiOperation({
    summary: 'Activate or deactivate a promotion',
    description:
      'ACTIVATING re-runs the conflict check: a promotion may have been ' +
      'deactivated precisely because it tied with another, and switching it ' +
      'back on must not resurrect an ambiguity. Deactivating never conflicts. ' +
      'A no-op transition is refused rather than silently succeeding.',
  })
  @ApiOkResponse({ description: 'The promotion in its new state.' })
  @ApiBadRequestResponse({ description: 'Activating would create an ambiguous overlap.' })
  @ApiNotFoundResponse({ description: 'No such property or promotion, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'Already in that state.' })
  setStatus(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
    @Body(new ZodValidationPipe(promotionStatusSchema))
    body: PromotionStatusAction,
  ): Promise<PromotionView> {
    return this.promotions.setStatus(this.userId(request), hotelId, promotionId, body);
  }

  /** `204`: a successful delete has nothing to return. */
  @Delete(':hotelId/promotions/:promotionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a promotion, when safe',
    description:
      'Refused when a redemption references it — a redemption is a financial ' +
      'record, and deleting the promotion a stay was discounted under would ' +
      'destroy the explanation of a charge. Deactivate instead. In F5 no ' +
      'redemption can exist, because nothing consumes one until F9; the check ' +
      'is here so it is correct when that changes.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiBadRequestResponse({ description: 'The promotion has been redeemed.' })
  @ApiNotFoundResponse({ description: 'No such property or promotion, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  remove(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
  ): Promise<void> {
    return this.promotions.remove(this.userId(request), hotelId, promotionId);
  }

  /* -- Promo codes -------------------------------------------------------- */

  @Get(':hotelId/promotions/:promotionId/codes')
  @ApiOperation({
    summary: "A promotion's codes",
    description:
      'The display form of each code is returned; the normalised form used for ' +
      'matching is never published. A promotion with any code REQUIRES one to ' +
      'be supplied; one with none applies automatically to an eligible stay.',
  })
  @ApiOkResponse({ description: 'The codes, with usage limits and remaining usage.' })
  @ApiNotFoundResponse({ description: 'No such property or promotion, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:read.' })
  listCodes(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
  ): Promise<PromoCodeListResponse> {
    return this.promotions.listCodes(this.userId(request), hotelId, promotionId);
  }

  @Post(':hotelId/promotions/:promotionId/codes')
  @ApiOperation({
    summary: 'Create a promo code',
    description:
      'A code is a redemption mechanism, not a second discount engine: it ' +
      'carries no discount of its own. Stored twice — as entered for display, ' +
      'and upper-cased and trimmed for matching — so lookup is ' +
      'case-insensitive and whitespace-insensitive without depending on a ' +
      'collation. The normalised form is unique per property.',
  })
  @ApiCreatedResponse({ description: 'The created code.' })
  @ApiNotFoundResponse({ description: 'No such property or promotion, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'That code already exists at this property.' })
  createCode(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
    @Body(new ZodValidationPipe(createPromoCodeRequestSchema))
    body: CreatePromoCodeRequest,
  ): Promise<PromoCodeView> {
    return this.promotions.createCode(this.userId(request), hotelId, promotionId, body);
  }

  @Patch(':hotelId/promotions/:promotionId/codes/:codeId/status')
  @ApiOperation({
    summary: 'Activate, deactivate or expire a promo code',
    description:
      'Deactivating is reversible. Setting `expiresOn` expires it from that ' +
      'calendar date, inclusive. Note that deactivating the last usable code ' +
      'does NOT open the promotion to everybody: a promotion with any code ' +
      'remains code-gated, so it simply becomes unusable until a code is ' +
      'reactivated.',
  })
  @ApiOkResponse({ description: 'The code in its new state.' })
  @ApiNotFoundResponse({ description: 'No such property, promotion or code, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  @ApiConflictResponse({ description: 'Already in that state.' })
  setCodeStatus(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
    @Param('codeId') codeId: string,
    @Body(new ZodValidationPipe(promoCodeStatusSchema))
    body: PromoCodeStatusAction,
  ): Promise<PromoCodeView> {
    return this.promotions.setCodeStatus(this.userId(request), hotelId, promotionId, codeId, body);
  }

  @Delete(':hotelId/promotions/:promotionId/codes/:codeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a promo code, when safe',
    description: 'Refused when the code has been redeemed. Deactivate instead.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiBadRequestResponse({ description: 'The code has been redeemed.' })
  @ApiNotFoundResponse({ description: 'No such property, promotion or code, or no grant.' })
  @ApiForbiddenResponse({ description: 'A grant without rates:manage.' })
  removeCode(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Param('promotionId') promotionId: string,
    @Param('codeId') codeId: string,
  ): Promise<void> {
    return this.promotions.removeCode(this.userId(request), hotelId, promotionId, codeId);
  }

  /** Unreachable while `SessionAuthGuard` is attached; asserted so that
   *  detaching it fails closed rather than reading a property of `undefined`. */
  private userId(request: FastifyRequest): string {
    const user = (request as unknown as AuthenticatedRequest).user;
    if (user === undefined) throw new UnauthenticatedError();
    return user.userId;
  }
}
