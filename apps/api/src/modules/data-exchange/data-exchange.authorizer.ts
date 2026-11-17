/**
 * Grant resolution for import and export, in the order every module uses:
 * no grant → not-found (never confirms another property exists, section 3.2);
 * a grant without the permission → 403.
 */

import { Injectable } from '@nestjs/common';
import type { Permission } from '@repo/types';

import { TenantScopeViolationError } from '../../common/errors/domain-error.js';
import { requirePermissionFromGrants } from '../../common/property-scope/require-permission.js';
import { grantedPropertyWhere } from '../../common/property-scope/property-identifier.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class DataExchangeAuthorizer {
  constructor(private readonly prisma: PrismaService) {}

  async authorise(
    userId: string,
    hotelId: string,
    required: readonly Permission[],
  ): Promise<{ propertyId: string; code: string; businessDate: string }> {
    const grants = await this.prisma.client.userPropertyRole.findMany({
      where: grantedPropertyWhere({ userId, codeOrId: hotelId, operableOnly: false }),
      select: {
        role: { select: { key: true } },
        property: { select: { id: true, code: true, businessDate: true } },
      },
    });
    const first = grants[0];
    if (first === undefined) throw new TenantScopeViolationError('Property');
    for (const permission of required) requirePermissionFromGrants(grants, permission);
    return {
      propertyId: first.property.id,
      code: first.property.code,
      // A calendar date (`@db.Date`), so the UTC rendering is the date itself.
      businessDate: first.property.businessDate.toISOString().slice(0, 10),
    };
  }
}
