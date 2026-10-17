/**
 * Resolves and authorises the property a request operates on.
 *
 * This is the guard CLAUDE.md section 3.2 describes. It is the single place
 * the active `propertyId` is established, and it establishes it by
 * *verifying* a grant — never by trusting what the client sent.
 *
 * Resolution order:
 *   1. `:propertyId` route parameter (the RBAC management endpoints use this)
 *   2. `x-property-id` request header (the admin shell's property switcher)
 *   3. the `pid` claim in the session token, set by `POST
 *      /properties/select-context` when the operator picked a property on the
 *      group dashboard
 *   4. the subject's single grant, when they only have one
 *
 * Whichever it came from, the value is then checked against the caller's
 * `UserPropertyRole` rows. An unauthorised property is reported as 404, not
 * 403: a 403 would confirm the property exists, which is itself a
 * cross-tenant leak.
 */

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import {
  isRole,
  OPERABLE_PROPERTY_STATUSES,
  permissionsForRoles,
  type ActivePropertyContext,
  type Permission,
  type PropertyId,
  type Role,
} from '@repo/types';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedRequest } from '../auth/authenticated-user.js';
import { PropertyContextService } from '../context/property-context.service.js';
import { TenantScopeViolationError, UnauthenticatedError } from '../errors/domain-error.js';

interface ResolvedGrants {
  roles: Role[];
  customRoleNames: string[];
  permissions: Permission[];
  isPortfolioOperator: boolean;
}

@Injectable()
export class ActivePropertyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly propertyContext: PropertyContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (user === undefined) {
      throw new UnauthenticatedError();
    }

    const requested = this.requestedPropertyId(request);
    const propertyId = requested ?? (await this.soleGrantedProperty(user.userId));

    if (propertyId === null) {
      // No property named and the user has access to none (or to several, in
      // which case they must choose). Reported as not-found for the same
      // reason as below.
      throw new TenantScopeViolationError('Property');
    }

    // ONBOARDING counts as reachable: staff have to be able to sign in and
    // configure a property before it can start trading. Only INACTIVE is
    // closed, and it reads as not-found for the same reason a cross-tenant
    // request does.
    const property = await this.prisma.client.property.findFirst({
      where: { id: propertyId, status: { in: [...OPERABLE_PROPERTY_STATUSES] } },
      select: { id: true, slug: true },
    });

    if (property === null) {
      throw new TenantScopeViolationError('Property');
    }

    const grants = await this.resolveGrants(user.userId, propertyId);

    // Holding no role at this property is indistinguishable, to the caller,
    // from the property not existing. That is deliberate.
    if (grants.roles.length === 0 && grants.customRoleNames.length === 0) {
      throw new TenantScopeViolationError('Property');
    }

    const activeContext: ActivePropertyContext = {
      propertyId: property.id,
      propertySlug: property.slug,
      userId: user.userId,
      roles: grants.roles,
      permissions: grants.permissions,
      isPortfolioOperator: grants.isPortfolioOperator,
    };

    request.activePropertyContext = activeContext;

    // Also bind it to AsyncLocalStorage so repositories can read the tenant
    // without it being threaded through every call signature.
    this.propertyContext.enter({
      // Safe: `property.id` came back from a `Property` row, so it is a real
      // property identifier; the brand only exists at the type level.
      propertyId: activeContext.propertyId as PropertyId,
      subject: null,
      requestId: request.id,
    });

    return true;
  }

  private requestedPropertyId(request: AuthenticatedRequest): string | null {
    const fromRoute = request.params['propertyId'];
    if (typeof fromRoute === 'string' && fromRoute.length > 0) return fromRoute;

    const header = request.headers['x-property-id'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;

    // The property the operator selected on the group dashboard, carried in
    // the signed session token. Reading it here is safe for the same reason
    // the header above is: every candidate, wherever it came from, is checked
    // against the caller's own grants below. The signature only means this one
    // cannot be edited in the browser, unlike a plain cookie — which is
    // precisely why select-context re-signs the session instead of setting an
    // `active_property_id` cookie the client could rewrite.
    const fromToken = request.user?.activePropertyId;
    if (typeof fromToken === 'string' && fromToken.length > 0) return fromToken;

    return null;
  }

  /** When a user has exactly one property, do not make them name it. */
  private async soleGrantedProperty(userId: string): Promise<string | null> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: { userId },
      select: { propertyId: true },
      distinct: ['propertyId'],
      take: 2,
    });
    return grants.length === 1 ? (grants[0]?.propertyId ?? null) : null;
  }

  /**
   * Flattens every role the user holds at this property into one permission
   * set — the union, because a clerk holding Front Desk *and* Night Auditor
   * can do both jobs.
   */
  private async resolveGrants(userId: string, propertyId: string): Promise<ResolvedGrants> {
    const rows = await this.prisma.client.userPropertyRole.findMany({
      where: { userId, propertyId },
      select: {
        role: {
          select: {
            key: true,
            name: true,
            isCustom: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
    });

    const roles: Role[] = [];
    const customRoleNames: string[] = [];
    const permissions = new Set<Permission>();

    for (const row of rows) {
      if (row.role.key !== null && isRole(row.role.key)) {
        roles.push(row.role.key);
      } else {
        customRoleNames.push(row.role.name);
      }
      // A custom role's permissions come from its own grant rows, and a
      // system template's are stored too, so this covers both without
      // special-casing.
      for (const link of row.role.permissions) {
        permissions.add(link.permission.key as Permission);
      }
    }

    const isPortfolioOperator = roles.includes('SUPER_ADMIN');

    // A portfolio operator's template permissions are taken from code rather
    // than the row set, so adding a permission to SUPER_ADMIN does not require
    // a re-seed before it takes effect.
    if (isPortfolioOperator) {
      for (const permission of permissionsForRoles(['SUPER_ADMIN'])) {
        permissions.add(permission);
      }
    }

    return {
      roles,
      customRoleNames,
      permissions: [...permissions],
      isPortfolioOperator,
    };
  }
}
