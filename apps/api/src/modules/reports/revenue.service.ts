/**
 * The revenue screen's data (RP-10): a property's closed days, as the night
 * audit froze them.
 *
 * Only closed days. A day the audit has not closed is counted in `openDays`
 * and not shown, because revenue for a day still trading is not revenue on the
 * books. A day before the business date with no snapshot (from before the
 * audit existed, or an audit that did not run) is listed in `missingDates`, so
 * a gap is never mistaken for a quiet day.
 *
 * Authorisation is the reports' own: a property the caller holds no grant at is
 * not found (CLAUDE.md section 3.2); a grant without `financial_reports:read`
 * is a 403, because housekeeping is read-only on financials.
 */

import { Injectable } from '@nestjs/common';
import {
  addDays,
  enumerateStayDates,
  Permission,
  permissionsForRoles,
  REVENUE_MAX_DAYS,
  totalClosedDays,
  type BusinessDate,
  type RevenueOverview,
  type RevenueQuery,
  type Role,
} from '@repo/types';

import {
  ForbiddenError,
  TenantScopeViolationError,
  ValidationFailedError,
} from '../../common/errors/domain-error.js';
import { isoDate, toClosedDay } from '../../common/reporting/daily-snapshots.js';
import { ReportsRepository } from './reports.repository.js';

function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

@Injectable()
export class RevenueService {
  constructor(private readonly repository: ReportsRepository) {}

  async overview(userId: string, hotelId: string, query: RevenueQuery): Promise<RevenueOverview> {
    const granted = await this.repository.findGrantedProperty(userId, hotelId);
    if (granted === null) throw new TenantScopeViolationError('Property');
    if (!permissionsForRoles(granted.roles as Role[]).includes(Permission.FINANCIAL_REPORTS_READ)) {
      throw new ForbiddenError('Reading financial reports');
    }
    const { property } = granted;

    const businessDate = isoDate(property.businessDate);
    const lastClosed = addDays(businessDate, -1);
    const to = query.to ?? lastClosed;
    const from = query.from ?? (`${to.slice(0, 7)}-01` as BusinessDate);
    if (to < from) {
      throw new ValidationFailedError({ from: `"from" ${from} is after "to" ${to}.` });
    }
    const window = enumerateStayDates({ arrivalDate: from, departureDate: addDays(to, 1) });
    if (window.length > REVENUE_MAX_DAYS) {
      throw new ValidationFailedError({
        to: `The window is limited to ${String(REVENUE_MAX_DAYS)} days; ${String(window.length)} requested.`,
      });
    }

    const rows = await this.repository.findClosedDays(
      property.id,
      toUtcMidnight(from),
      toUtcMidnight(to),
    );
    const days = rows.map(toClosedDay);
    const snapshotted = new Set(days.map((day) => day.businessDate));

    return {
      propertyName: property.name,
      propertyCode: property.code,
      currency: property.currency,
      timeZone: property.timezone,
      businessDate,
      from,
      to,
      days,
      totals: totalClosedDays(days),
      missingDates: window.filter((date) => date < businessDate && !snapshotted.has(date)),
      openDays: window.filter((date) => date >= businessDate).length,
    };
  }
}
