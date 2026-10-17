/**
 * Group (portfolio) endpoints.
 *
 * These sit *above* the tenant boundary rather than inside it, which is why
 * they carry `SessionAuthGuard` alone and not `ActivePropertyGuard`: their job
 * is to tell the caller which properties exist for them and to choose one, so
 * there is no active property yet to scope by. `ActivePropertyGuard` would
 * reject them for exactly that reason.
 *
 * Nothing here accepts a property from the client as an assertion. `my-group`
 * derives the set from the caller's grants, and `select-context` re-verifies
 * the requested id against those grants before honouring it.
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  listGroupPropertiesQuerySchema,
  selectPropertyContextRequestSchema,
  type GroupPropertiesResponse,
  type ListGroupPropertiesQuery,
  type SelectPropertyContextRequest,
  type SelectPropertyContextResponse,
} from '@repo/types';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedRequest } from '../../common/auth/authenticated-user.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import {
  serializeSessionCookie,
  sessionCookieAttributes,
  sessionCookieName,
} from '../../common/auth/session-cookie.js';
import { UnauthenticatedError } from '../../common/errors/domain-error.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PropertiesService } from './properties.service.js';

@ApiTags('properties')
@ApiBearerAuth('access-token')
@Controller('properties')
@UseGuards(SessionAuthGuard)
export class PropertiesController {
  private readonly cookieName: string;

  constructor(
    private readonly properties: PropertiesService,
    private readonly config: ConfigService,
  ) {
    this.cookieName = sessionCookieName(config);
  }

  @Get('my-group')
  @ApiOperation({
    summary: 'Every property the caller holds a role at',
    description:
      'The post-login group dashboard. Cross-property by design and scoped ' +
      'to the caller’s own grants — a property they hold no role at is never ' +
      'selected, not merely filtered out.',
  })
  @ApiOkResponse({ description: 'The caller’s property group.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  listMyGroup(
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listGroupPropertiesQuerySchema)) query: ListGroupPropertiesQuery,
  ): Promise<GroupPropertiesResponse> {
    const user = requireUser(request);
    return this.properties.listMyGroup(user.userId, query);
  }

  @Post('select-context')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set the caller’s active property',
    description:
      'Verifies the caller holds a role at the requested property, then ' +
      're-issues the session cookie carrying it. The active property lives in ' +
      'the signed token rather than a client-readable cookie, so it cannot be ' +
      'edited in the browser (CLAUDE.md section 3.2).',
  })
  @ApiOkResponse({ description: 'Active property set; session cookie re-issued.' })
  @ApiNotFoundResponse({ description: 'No such property, or no grant at it.' })
  async selectContext(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body(new ZodValidationPipe(selectPropertyContextRequestSchema))
    body: SelectPropertyContextRequest,
  ): Promise<SelectPropertyContextResponse> {
    const user = requireUser(request);

    const selected = await this.properties.selectContext(
      user.userId,
      user.email,
      body.propertyId,
    );

    reply.header(
      'set-cookie',
      serializeSessionCookie(
        this.cookieName,
        selected.token,
        sessionCookieAttributes(this.config, selected.response.expiresIn),
      ),
    );

    return selected.response;
  }
}

/**
 * Unreachable while SessionAuthGuard is attached. Asserted so that detaching
 * the guard fails closed rather than reading someone's group out of undefined.
 */
function requireUser(request: FastifyRequest): { userId: string; email: string } {
  const user = (request as unknown as AuthenticatedRequest).user;
  if (user === undefined) {
    throw new UnauthenticatedError();
  }
  return { userId: user.userId, email: user.email };
}
