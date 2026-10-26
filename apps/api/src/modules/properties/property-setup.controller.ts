/**
 * Property configuration endpoints.
 *
 * Addressed by an explicit `:hotelId` like the folio and reservation routes,
 * rather than reading the active property from the session. A staff member
 * with grants at several hotels configures a specific one, and the service
 * re-verifies the grant on every call — the id in the path is a request, not
 * an assertion (CLAUDE.md section 3.2).
 *
 * The controller does nothing but validate and delegate. No Prisma, no
 * authorisation logic, no error shaping: those belong to the service, the
 * guard and `DomainExceptionFilter` respectively (section 5).
 */

import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  createPropertyMediaSchema,
  replaceAmenitiesSchema,
  replaceFeesSchema,
  replacePoliciesSchema,
  replaceTaxSlabsSchema,
  updatePropertySettingsSchema,
  type CreatePropertyMedia,
  type PropertyMedia,
  type PropertySetup,
  type ReplaceAmenities,
  type ReplaceFees,
  type ReplacePolicies,
  type ReplaceTaxSlabs,
  type UpdatePropertySettings,
} from '@repo/types';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PropertySetupService } from './property-setup.service.js';

@ApiTags('properties')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class PropertySetupController {
  constructor(private readonly setup: PropertySetupService) {}

  @Get(':hotelId/setup')
  @ApiOperation({
    summary: 'Everything the property settings screen needs',
    description:
      'Settings, GST slabs, amenities, policies, fees and media in one ' +
      'response — five tabs of one form, so one round trip. Requires ' +
      '`property:settings`: these are the inputs to every money calculation, ' +
      'not a public profile.',
  })
  @ApiOkResponse({ description: 'The property configuration.' })
  @ApiForbiddenResponse({ description: 'No `property:settings` permission.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  get(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
  ): Promise<PropertySetup> {
    return this.setup.setup(userId(request), hotelId);
  }

  @Patch(':hotelId/settings')
  @ApiOperation({
    summary: 'Update the operational settings',
    description:
      'Partial: only the fields present are written, so saving one tab ' +
      'cannot reset another. Writes an `audit_log` row naming the actor and ' +
      'the before/after of exactly the fields that moved, in the same ' +
      'transaction as the change (CLAUDE.md section 3.4).',
  })
  @ApiOkResponse({ description: 'The configuration after the change.' })
  @ApiBadRequestResponse({ description: 'A field failed validation.' })
  patchSettings(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(updatePropertySettingsSchema))
    body: UpdatePropertySettings,
  ): Promise<PropertySetup> {
    return this.setup.updateSettings(userId(request), hotelId, body);
  }

  @Put(':hotelId/tax-slabs')
  @ApiOperation({
    summary: 'Replace the GST slab table',
    description:
      'The whole table at once, not slab by slab. A table is only valid as a ' +
      'set — a floor at zero, no gaps, no overlaps, one open-ended top band — ' +
      'so it is validated and swapped inside one transaction, and no quote ' +
      'ever prices against a half-replaced table. A rejected table leaves the ' +
      'live one untouched.',
  })
  @ApiOkResponse({ description: 'The configuration after the change.' })
  @ApiBadRequestResponse({
    description: 'The table has a gap, an overlap, or no open-ended band.',
  })
  putTaxSlabs(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(replaceTaxSlabsSchema)) body: ReplaceTaxSlabs,
  ): Promise<PropertySetup> {
    return this.setup.replaceTaxSlabs(userId(request), hotelId, body.slabs, body.reason);
  }

  @Put(':hotelId/amenities')
  @ApiOperation({
    summary: 'Replace which amenities the property offers',
    description:
      'The amenity catalogue is portfolio-wide and is not edited here — Wi-Fi ' +
      'means the same thing at all ten hotels. This sets the links: offered ' +
      'or not, free or paid, and the price. Audited in the same transaction.',
  })
  @ApiOkResponse({ description: 'The configuration after the change.' })
  @ApiBadRequestResponse({
    description: 'A duplicate amenity, an unknown one, or a price that contradicts its scope.',
  })
  putAmenities(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(replaceAmenitiesSchema)) body: ReplaceAmenities,
  ): Promise<PropertySetup> {
    return this.setup.replaceAmenities(
      userId(request),
      hotelId,
      body.amenities,
      body.reason,
    );
  }

  @Put(':hotelId/policies')
  @ApiOperation({
    summary: 'Replace the published policies',
    description:
      'As a set, not row by row: a policy carries no natural key, so matching ' +
      'an edit to a row would mean matching on the title — and renaming one ' +
      'would create a second policy beside the original instead of changing it.',
  })
  @ApiOkResponse({ description: 'The configuration after the change.' })
  @ApiBadRequestResponse({ description: 'A field failed validation.' })
  putPolicies(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(replacePoliciesSchema)) body: ReplacePolicies,
  ): Promise<PropertySetup> {
    return this.setup.replacePolicies(userId(request), hotelId, body.policies, body.reason);
  }

  @Put(':hotelId/fees')
  @ApiOperation({
    summary: 'Replace the fees and surcharges',
    description:
      'Recorded, not yet billed: no charge path reads these, and the screen ' +
      'says so. Configuring them means the module that posts them later finds ' +
      'the policy already set rather than asking for it again.',
  })
  @ApiOkResponse({ description: 'The configuration after the change.' })
  @ApiBadRequestResponse({
    description: 'A fee carrying both a rate and a fixed amount, or neither.',
  })
  putFees(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(replaceFeesSchema)) body: ReplaceFees,
  ): Promise<PropertySetup> {
    return this.setup.replaceFees(userId(request), hotelId, body.fees, body.reason);
  }

  @Post(':hotelId/media')
  @ApiOperation({
    summary: 'Record a photograph against the property',
    description:
      'Takes a URL rather than file bytes: this records where an image ' +
      'lives. Nothing in this repository stores uploads, and accepting a ' +
      'multipart body would mean inventing an object store, a bucket policy ' +
      'and a cleanup path in the same change (CLAUDE.md section 6.4).',
  })
  @ApiOkResponse({ description: 'The recorded media row.' })
  @ApiBadRequestResponse({ description: 'A field failed validation.' })
  postMedia(
    @Req() request: FastifyRequest,
    @Param('hotelId') hotelId: string,
    @Body(new ZodValidationPipe(createPropertyMediaSchema)) body: CreatePropertyMedia,
  ): Promise<PropertyMedia> {
    return this.setup.addMedia(userId(request), hotelId, body);
  }
}

/**
 * Unreachable while SessionAuthGuard is attached. Asserted so that detaching
 * the guard fails closed rather than configuring a property as `undefined`.
 */
function userId(request: FastifyRequest): string {
  const user = (request as AuthenticatedRequest).user;
  if (user === undefined) throw new UnauthenticatedError();
  return user.userId;
}
