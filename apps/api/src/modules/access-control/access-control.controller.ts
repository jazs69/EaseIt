/**
 * RBAC management endpoints.
 *
 * Guard order is load-bearing and must stay as listed:
 *   SessionAuthGuard     — establishes *who*, from the signed session cookie
 *   ActivePropertyGuard  — establishes *where*, and verifies the grant
 *   PermissionsGuard     — establishes *whether*, from @RequirePermissions
 *
 * Note the `:propertyId` path parameter. Taking a tenant id from the URL is
 * fine precisely because ActivePropertyGuard does not trust it: it is a lookup
 * key that is then checked against the caller's own grants, and an
 * unauthorised value comes back as 404 (CLAUDE.md section 3.2).
 *
 * This controller never touches Prisma — that is the service's job, and the
 * shared ESLint config enforces it.
 */

import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  assignRolesRequestSchema,
  createRoleRequestSchema,
  inviteStaffRequestSchema,
  userActivationRequestSchema,
  listStaffQuerySchema,
  Permission,
  updateRoleRequestSchema,
  type ActiveContextDto,
  type ActivePropertyContext,
  type AssignRolesRequest,
  type CreateRoleRequest,
  type InviteStaffRequest,
  type InviteStaffResult,
  type UserActivationRequest,
  type ListStaffQuery,
  type RoleDetailDto,
  type StaffMemberDto,
  type UpdateRoleRequest,
} from '@repo/types';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { ActiveContext } from '../../common/decorators/active-context.decorator.js';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator.js';
import { ActivePropertyGuard } from '../../common/guards/active-property.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AccessControlService } from './access-control.service.js';

@ApiTags('access-control')
@ApiBearerAuth('access-token')
@Controller('properties/:propertyId')
@UseGuards(SessionAuthGuard, ActivePropertyGuard, PermissionsGuard)
export class AccessControlController {
  constructor(private readonly accessControl: AccessControlService) {}

  /* -- Session ------------------------------------------------------------ */

  @Get('me')
  @ApiOperation({
    summary: 'The caller’s resolved roles and permissions at this property',
  })
  @ApiOkResponse({ description: 'Active property context for the current user.' })
  me(@ActiveContext() context: ActivePropertyContext): ActiveContextDto {
    return {
      propertyId: context.propertyId as ActiveContextDto['propertyId'],
      propertySlug: context.propertySlug,
      userId: context.userId as ActiveContextDto['userId'],
      // Role summaries are resolved by the service for the directory; here the
      // UI only needs the permission set, so the role list stays empty rather
      // than triggering another query.
      roles: [],
      permissions: [...context.permissions],
      isPortfolioOperator: context.isPortfolioOperator,
    };
  }

  /* -- Roles -------------------------------------------------------------- */

  @Get('roles')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List system templates and this property’s custom roles' })
  @ApiOkResponse({ description: 'Roles grantable at this property.' })
  listRoles(@ActiveContext() context: ActivePropertyContext): Promise<RoleDetailDto[]> {
    return this.accessControl.listRoles(context);
  }

  @Post('roles')
  @RequirePermissions(Permission.ROLES_MANAGE)
  @ApiOperation({ summary: 'Create a custom role for this property' })
  @ApiOkResponse({ description: 'The created role.' })
  createRole(
    @ActiveContext() context: ActivePropertyContext,
    @Body(new ZodValidationPipe(createRoleRequestSchema)) body: CreateRoleRequest,
  ): Promise<RoleDetailDto> {
    return this.accessControl.createRole(context, body);
  }

  @Patch('roles/:roleId')
  @RequirePermissions(Permission.ROLES_MANAGE)
  @ApiOperation({ summary: 'Update a custom role’s name, description or permissions' })
  @ApiOkResponse({ description: 'The updated role.' })
  updateRole(
    @ActiveContext() context: ActivePropertyContext,
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(updateRoleRequestSchema)) body: UpdateRoleRequest,
  ): Promise<RoleDetailDto> {
    return this.accessControl.updateRole(context, roleId, body);
  }

  /* -- Staff -------------------------------------------------------------- */

  @Get('users')
  @RequirePermissions(Permission.USERS_READ)
  @ApiOperation({ summary: 'List staff at this property with their assigned roles' })
  @ApiOkResponse({ description: 'Staff directory for this property.' })
  listStaff(
    @ActiveContext() context: ActivePropertyContext,
    @Query(new ZodValidationPipe(listStaffQuerySchema)) query: ListStaffQuery,
  ): Promise<StaffMemberDto[]> {
    return this.accessControl.listStaff(context, {
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.roleId === undefined ? {} : { roleId: query.roleId }),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      limit: query.limit,
    });
  }

  @Post('users/assign-roles')
  @RequirePermissions(Permission.USERS_MANAGE)
  @ApiOperation({
    summary: 'Replace a staff member’s roles at this property (multi-role)',
  })
  @ApiOkResponse({ description: 'The staff member with their new role set.' })
  assignRoles(
    @ActiveContext() context: ActivePropertyContext,
    @Body(new ZodValidationPipe(assignRolesRequestSchema)) body: AssignRolesRequest,
  ): Promise<StaffMemberDto> {
    return this.accessControl.assignRoles(context, body.userId, body.roleIds);
  }

  @Post('users/invite')
  @RequirePermissions(Permission.USERS_MANAGE)
  @ApiOperation({
    summary: 'Invite a person to this property (AU-14)',
    description:
      'Creates the account if needed, grants the roles here, and emails a single-use link to ' +
      'set a first password. An existing account is just granted the roles (NOT_NEEDED).',
  })
  @ApiOkResponse({ description: 'The staff member, and what happened to the invitation.' })
  invite(
    @ActiveContext() context: ActivePropertyContext,
    @Body(new ZodValidationPipe(inviteStaffRequestSchema)) body: InviteStaffRequest,
  ): Promise<InviteStaffResult> {
    return this.accessControl.inviteStaff(context, body);
  }

  @Post('users/:userId/deactivate')
  @RequirePermissions(Permission.USERS_MANAGE)
  @ApiOperation({
    summary: 'Deactivate a person (AU-15)',
    description:
      'They cannot sign in, every session they hold stops working, and unused reset or ' +
      'invitation links are revoked. Refused (409 DEACTIVATION_REFUSED) for oneself, a portfolio ' +
      'operator, or someone who also works at another property, unless the caller is a portfolio operator.',
  })
  @ApiOkResponse({ description: 'The staff member, now inactive.' })
  @ApiConflictResponse({ description: 'Refused, with the reason.' })
  @ApiNotFoundResponse({ description: 'No such person at this property.' })
  deactivate(
    @ActiveContext() context: ActivePropertyContext,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(userActivationRequestSchema)) body: UserActivationRequest,
  ): Promise<StaffMemberDto> {
    return this.accessControl.deactivate(context, userId, body.reason);
  }

  @Post('users/:userId/reactivate')
  @RequirePermissions(Permission.USERS_MANAGE)
  @ApiOperation({ summary: 'Reactivate a person (AU-15). Sessions revoked earlier stay revoked.' })
  @ApiOkResponse({ description: 'The staff member, active again.' })
  reactivate(
    @ActiveContext() context: ActivePropertyContext,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(userActivationRequestSchema)) body: UserActivationRequest,
  ): Promise<StaffMemberDto> {
    return this.accessControl.reactivate(context, userId, body.reason);
  }
}
