/**
 * Group dashboard application service.
 *
 * Maps persistence rows to the wire contract and composes the display address.
 * The Prisma row never leaves this layer (CLAUDE.md section 5): returning it
 * would publish `legalName`, `checkInTime` and every column added later to a
 * screen that asked for four fields.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  primaryRole,
  PropertyStatus,
  type BusinessDate,
  type GroupPropertiesResponse,
  type GroupProperty,
  type ListGroupPropertiesQuery,
  type PropertyId,
  type SelectPropertyContextResponse,
} from '@repo/types';

import { TenantScopeViolationError } from '../../common/errors/domain-error.js';
import { TokenService } from '../../common/auth/token.service.js';
import {
  PropertiesRepository,
  type GroupPropertyRow,
} from './properties.repository.js';

export interface SelectedContext {
  response: SelectPropertyContextResponse;
  /** Re-signed session token. The controller sets it as the cookie. */
  token: string;
}

@Injectable()
export class PropertiesService {
  private readonly logger = new Logger(PropertiesService.name);

  constructor(
    private readonly repository: PropertiesRepository,
    private readonly tokens: TokenService,
  ) {}

  async listMyGroup(
    userId: string,
    query: ListGroupPropertiesQuery,
  ): Promise<GroupPropertiesResponse> {
    const [rows, totalUnfiltered] = await Promise.all([
      this.repository.findGroupProperties(userId, {
        // 'ALL' is a filter option, not a status — it maps to "no predicate"
        // rather than to a value the database could ever hold.
        ...(query.status === 'ALL' ? {} : { status: query.status }),
        ...(query.search === undefined ? {} : { search: query.search }),
      }),
      this.repository.countAllGroupProperties(userId),
    ]);

    const properties = rows.map(toGroupProperty);

    return { total: properties.length, totalUnfiltered, properties };
  }

  /**
   * Switches the caller's active property.
   *
   * ===========================================================================
   * The new active property goes into a **re-signed session token**, not into a
   * client-readable cookie.
   *
   * A plain `active_property_id` cookie would be a tenant identifier the
   * browser asserts, and the browser can edit its own cookies — so switching
   * hotel would become a matter of typing a different uuid. CLAUDE.md
   * section 3.2 forbids exactly that: `propertyId` is never read from a
   * client-supplied header, body or cookie.
   *
   * Signing it into the session means tampering invalidates the signature. And
   * it is still only a *hint*: `ActivePropertyGuard` re-reads the caller's
   * grants on every subsequent request, so a token that somehow named a
   * property the user lost access to a minute ago is still refused.
   * ===========================================================================
   */
  async selectContext(
    userId: string,
    email: string,
    propertyId: string,
  ): Promise<SelectedContext> {
    const property = await this.repository.findGrantedProperty(userId, propertyId);

    if (property === null) {
      // Not-found, not forbidden: a 403 here would confirm the property exists
      // to someone who has no grant at it.
      this.logger.warn(`Rejected a property-context switch for user ${userId}`);
      throw new TenantScopeViolationError('Property');
    }

    const signed = this.tokens.sign({
      sub: userId,
      email,
      pid: property.id,
      // The session keeps whatever factors it already cleared. Switching
      // property is a scope change, not a re-authentication, and claiming
      // `otp` here for a session that never did one would be a lie.
      amr: ['pwd', 'otp'],
    });

    return {
      token: signed.token,
      response: {
        activePropertyId: property.id as PropertyId,
        propertySlug: property.slug,
        propertyName: property.name,
        expiresIn: signed.expiresIn,
      },
    };
  }
}

/**
 * Row -> DTO.
 *
 * The address is composed here from the structured columns rather than read
 * from a denormalised `address` field. One source of truth: `city` and a
 * duplicated address string cannot disagree if the string does not exist.
 */
function toGroupProperty(row: GroupPropertyRow): GroupProperty {
  const addressParts = [
    row.addressLine1,
    row.addressLine2,
    row.city,
    row.state,
    row.postalCode,
  ].filter((part): part is string => part !== null && part.trim().length > 0);

  return {
    id: row.id as PropertyId,
    code: row.code,
    name: row.name,
    slug: row.slug,
    division: row.division,
    address: addressParts.length === 0 ? null : addressParts.join(', '),
    city: row.city,
    state: row.state,
    status: row.status ?? PropertyStatus.ACTIVE,
    logoUrl: row.logoUrl,
    timezone: row.timezone,
    currency: row.currency,
    businessDate: row.businessDate as BusinessDate,
    userRole: primaryRole(row.roles),
    roles: row.roles,
    customRoleNames: row.customRoleNames,
  };
}
