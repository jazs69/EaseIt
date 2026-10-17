/**
 * Corporate accounts and the lookups the booking form needs.
 *
 * ===========================================================================
 * Two lookups, and they are honest about very different confidence levels.
 *
 * **GSTIN** is checked offline against its own mod-36 check digit. That is a
 * mathematical certainty about the *number*, and it catches every
 * single-character typo and transposition. It says nothing about whether the
 * business is registered — see `gstin.ts` for why no legal name is invented.
 *
 * **Postal code** is a call to a third-party service, proxied here rather than
 * made from the browser. Through the server it gets a timeout, a single
 * attempt and a sanitised response; from the browser it would get the user's
 * network, no timeout control, and a dependency on somebody else's CORS
 * policy (CLAUDE.md section 5 asks for a timeout and bounded retries on every
 * external call).
 *
 * A failed lookup is never an error the operator has to resolve. Both degrade
 * to "type it yourself", because a booking must not be blocked by a postal
 * API being slow.
 * ===========================================================================
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  CompanySummary,
  CreateCompanyCommand,
  GstinLookup,
  PostalLookup,
} from '@repo/types';

import {
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { GstService } from './gst.service.js';
import { inspectGstin } from './gstin.js';

/** Short enough that a slow third party cannot hold up a booking form. */
const POSTAL_TIMEOUT_MS = 2_500;
const POSTAL_ENDPOINT = 'https://api.postalpincode.in/pincode';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gst: GstService,
  ) {}

  /* -------------------------------------------------------------------- */
  /*  Companies                                                           */
  /* -------------------------------------------------------------------- */

  async list(userId: string, hotelId: string): Promise<CompanySummary[]> {
    const propertyId = await this.resolveProperty(userId, hotelId);

    const rows = await this.prisma.client.company.findMany({
      where: { propertyId },
      select: {
        id: true,
        legalName: true,
        tradeName: true,
        gstin: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
        email: true,
        phone: true,
        gstinVerification: true,
        gstinProvider: true,
      },
      orderBy: { legalName: 'asc' },
    });

    return rows.map((row) => ({
      ...row,
      verification: row.gstinVerification,
      gstinProvider: row.gstinProvider,
    }));
  }

  async create(
    userId: string,
    hotelId: string,
    command: CreateCompanyCommand,
  ): Promise<CompanySummary> {
    const propertyId = await this.resolveProperty(userId, hotelId);

    // Validated server-side, not merely in the form: a malformed GSTIN on a
    // tax invoice is the hotel's problem, not the browser's.
    const inspection = inspectGstin(command.gstin);
    if (!inspection.isValid) {
      throw new ValidationFailedError({
        gstin: inspection.reason ?? 'That GSTIN is not valid.',
      });
    }

    const existing = await this.prisma.client.company.findFirst({
      where: { propertyId, gstin: inspection.gstin },
      select: { id: true, legalName: true },
    });

    if (existing !== null) {
      throw new ValidationFailedError({
        gstin: `That GSTIN is already saved here as "${existing.legalName}".`,
      });
    }

    /**
     * The provenance is re-derived here, not taken from the request.
     *
     * A client that could assert `VERIFIED` could launder a hand-typed name
     * into a verified one, and the whole value of the flag is that it cannot
     * be. The lookup is repeated — cheap against the mock provider, one call
     * against a live one — and the server's own answer is what gets stored
     * (CLAUDE.md section 5: server-owned fields are server-owned).
     */
    const confirmed = await this.gst.lookup(inspection.gstin);
    const verification = confirmed.success ? confirmed.verification : 'UNVERIFIED';

    const company = await this.prisma.client.company.create({
      data: {
        propertyId,
        legalName: command.legalName,
        tradeName: command.tradeName,
        gstin: inspection.gstin,
        addressLine1: command.addressLine1,
        city: command.city,
        // The state is taken from the GSTIN's own first two digits where the
        // operator did not give one: it is encoded in the number, so deriving
        // it is reading rather than guessing.
        state: command.state ?? inspection.stateName,
        postalCode: command.postalCode,
        email: command.email,
        phone: command.phone,
        gstinVerification: verification,
        gstinProvider: confirmed.provider === 'none' ? null : confirmed.provider,
        gstinVerifiedAt: verification === 'UNVERIFIED' ? null : new Date(),
      },
      select: {
        id: true,
        legalName: true,
        tradeName: true,
        gstin: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
        email: true,
        phone: true,
        gstinVerification: true,
        gstinProvider: true,
      },
    });

    return {
      ...company,
      verification: company.gstinVerification,
      gstinProvider: company.gstinProvider,
    };
  }

  /* -------------------------------------------------------------------- */
  /*  Lookups                                                             */
  /* -------------------------------------------------------------------- */

  /** Delegated: the provider strategy and its tagging live in `GstService`. */
  lookupGstin(gstin: string): Promise<GstinLookup> {
    return this.gst.lookup(gstin);
  }

  /**
   * City, state and country for an Indian PIN code.
   *
   * Returns `found: false` rather than throwing when the service is slow,
   * unreachable or does not recognise the code. None of those is an error the
   * operator can do anything about, and all of them have the same remedy:
   * type the address.
   */
  async lookupPostalCode(postalCode: string): Promise<PostalLookup> {
    const code = postalCode.trim();

    if (!/^[1-9][0-9]{5}$/.test(code)) {
      return {
        postalCode: code,
        found: false,
        city: null,
        state: null,
        countryCode: null,
        note: 'An Indian PIN code is six digits and does not start with zero.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, POSTAL_TIMEOUT_MS);

    try {
      const response = await fetch(`${POSTAL_ENDPOINT}/${code}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        return this.postalUnavailable(code, `lookup returned ${String(response.status)}`);
      }

      const payload: unknown = await response.json();
      const first = Array.isArray(payload) ? payload[0] : null;
      const offices = (first as { PostOffice?: unknown } | null)?.PostOffice;
      const office = Array.isArray(offices) ? offices[0] : null;

      if (office === null || typeof office !== 'object') {
        return {
          postalCode: code,
          found: false,
          city: null,
          state: null,
          countryCode: null,
          note: 'No post office is registered against that PIN code.',
        };
      }

      const record = office as Record<string, unknown>;
      const district = typeof record['District'] === 'string' ? record['District'] : null;
      const state = typeof record['State'] === 'string' ? record['State'] : null;

      return {
        postalCode: code,
        found: district !== null || state !== null,
        city: district,
        state,
        countryCode: 'IN',
        note: null,
      };
    } catch (error) {
      const reason =
        error instanceof DOMException && error.name === 'AbortError'
          ? `no response within ${String(POSTAL_TIMEOUT_MS)}ms`
          : 'the lookup service could not be reached';
      return this.postalUnavailable(code, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  private postalUnavailable(code: string, reason: string): PostalLookup {
    // Logged once, here, at the boundary that handles it — not rethrown and
    // logged again at every level it would pass through (section 5).
    this.logger.warn(`PIN lookup for ${code} failed: ${reason}`);
    return {
      postalCode: code,
      found: false,
      city: null,
      state: null,
      countryCode: null,
      note: 'Address lookup is unavailable. Enter the city and state manually.',
    };
  }

  /* -------------------------------------------------------------------- */

  private async resolveProperty(userId: string, codeOrId: string): Promise<string> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      codeOrId,
    );

    const grant = await this.prisma.client.userPropertyRole.findFirst({
      where: { userId, property: isUuid ? { id: codeOrId } : { code: codeOrId } },
      select: { propertyId: true },
    });

    if (grant === null) throw new TenantScopeViolationError('Property');
    return grant.propertyId;
  }
}
