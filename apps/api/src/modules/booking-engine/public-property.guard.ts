/**
 * BE-05: resolves `:slug` to a property, on the server, for every public route.
 *
 * ===========================================================================
 * The slug comes from the PATH, and only the path: no header, body field or
 * query parameter can name a property (CLAUDE.md 3.2). It is looked up as a
 * key, never trusted as an assertion of access — and it is the ONLY way a
 * public request acquires a property at all.
 *
 * Only an ACTIVE property is bookable. An unknown, onboarding or inactive
 * slug is not-found, with no hint which, so the public API cannot be used to
 * enumerate the portfolio.
 *
 * Like the session guard, it records the property for `TenantScopeInterceptor`,
 * so every query the handler makes is confined to that property by the
 * tenancy extension and by row-level security.
 * ===========================================================================
 */

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { EntityNotFoundError } from '../../common/errors/domain-error.js';
import { setRequestTenant } from '../../common/tenancy/tenant-scope.interceptor.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type PublicPropertyContext = {
  id: string;
  slug: string;
  code: string;
  name: string;
  city: string | null;
  currency: string;
  businessDate: string;
  checkInTime: string;
  checkOutTime: string;
};

const CONTEXT_KEY = 'easeitPublicProperty';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function publicProperty(request: unknown): PublicPropertyContext {
  const value = (request as Record<string, unknown>)[CONTEXT_KEY];
  if (value === undefined) throw new EntityNotFoundError('Property');
  return value as PublicPropertyContext;
}

@Injectable()
export class PublicPropertyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ params?: Record<string, string> }>();
    const slug = (request.params?.['slug'] ?? '').toLowerCase();
    if (!SLUG.test(slug)) throw new EntityNotFoundError('Property');

    // `Property` is portfolio-global: resolving it needs no tenant scope.
    const property = await this.prisma.client.property.findFirst({
      where: { slug, status: 'ACTIVE' },
      select: {
        id: true,
        slug: true,
        code: true,
        name: true,
        city: true,
        currency: true,
        businessDate: true,
        checkInTime: true,
        checkOutTime: true,
      },
    });
    if (property === null) throw new EntityNotFoundError('Property');

    const resolved: PublicPropertyContext = {
      ...property,
      currency: property.currency.trim(),
      // `@db.Date`: the UTC rendering is the hotel's calendar date itself.
      businessDate: property.businessDate.toISOString().slice(0, 10),
    };
    (request as Record<string, unknown>)[CONTEXT_KEY] = resolved;
    setRequestTenant(request, property.id);
    return true;
  }
}
