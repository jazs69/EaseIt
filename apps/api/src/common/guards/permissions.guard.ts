/**
 * Evaluates `@RequirePermissions` / `@RequireAnyPermission` against the
 * permission set that `ActivePropertyGuard` resolved for the active property.
 *
 * Must run *after* ActivePropertyGuard — Nest executes guards in the order
 * they are listed on `@UseGuards`.
 */

import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasAllPermissions, hasAnyPermission } from '@repo/types';

import type { AuthenticatedRequest } from '../auth/authenticated-user.js';
import {
  PERMISSIONS_METADATA_KEY,
  type RequiredPermissionsMetadata,
} from '../decorators/require-permissions.decorator.js';
import { ForbiddenError } from '../errors/domain-error.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RequiredPermissionsMetadata | undefined>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No decorator means no permission requirement. Authentication and
    // property scoping still applied via the guards before this one.
    if (required === undefined || required.permissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const active = request.activePropertyContext;

    if (active === undefined) {
      // A route asked for permissions but never resolved a property. That is a
      // wiring mistake, not a client error, so it must be loud.
      throw new Error(
        'PermissionsGuard ran without an active property context. List ' +
          'ActivePropertyGuard before PermissionsGuard on this route.',
      );
    }

    const granted = active.permissions;
    const satisfied =
      required.mode === 'all'
        ? hasAllPermissions(granted, required.permissions)
        : hasAnyPermission(granted, required.permissions);

    if (!satisfied) {
      const missing = required.permissions.filter((permission) => !granted.includes(permission));
      this.logger.warn(
        `Denied ${request.id}: user ${active.userId} at property ` +
          `${active.propertyId} lacks ${missing.join(', ')}`,
      );
      // Names the permission so an operator can be told what to request,
      // without revealing anything about the data behind the route.
      throw new ForbiddenError(required.permissions.join(` ${required.mode} `));
    }

    return true;
  }
}
