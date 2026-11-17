/**
 * @repo/types — the shared contract surface for EaseIt.
 *
 * Everything the API and both web apps agree on lives here: RBAC, money,
 * domain primitives and request/response DTOs. Nothing in this package may
 * import from an app, from @repo/database, or from @prisma/client — it is the
 * bottom of the dependency graph and must stay runtime-light.
 */

export * from './rbac.js';
export * from './money.js';
export * from './domain.js';
export * from './dto/access-control.dto.js';
export * from './dto/auth.dto.js';
export * from './dto/calendar.dto.js';
export * from './dto/cancel-reservation.dto.js';
export * from './dto/change-stay-dates.dto.js';
export * from './dto/front-desk-board.dto.js';
export * from './dto/folio.dto.js';
export * from './dto/invoice.dto.js';
export * from './dto/night-audit.dto.js';
export * from './dto/housekeeping.dto.js';
export * from './dto/group.dto.js';
export * from './dto/inventory.dto.js';
export * from './dto/room-type.dto.js';
export * from './dto/room.dto.js';
export * from './dto/room-block.dto.js';
export * from './dto/rate-plan.dto.js';
export * from './dto/rate-calendar.dto.js';
export * from './dto/rate-restriction.dto.js';
export * from './dto/rate-pricing-rule.dto.js';
export * from './dto/occupancy-pricing.dto.js';
export * from './dto/promotion.dto.js';
export * from './dto/check-in.dto.js';
export * from './dto/check-out.dto.js';
export * from './dto/create-reservation.dto.js';
export * from './dto/performance.dto.js';
export * from './dto/reports.dto.js';
export * from './dto/outbox.dto.js';
export * from './dto/audit-log.dto.js';
export * from './dto/daily-snapshot.dto.js';
export * from './dto/master-report-columns.js';
export * from './dto/reservation-detail.dto.js';
export * from './dto/room-move.dto.js';
export * from './dto/reservation-search.dto.js';
export * from './dto/property-dashboard.dto.js';
export * from './dto/timeline.dto.js';
export * from './dto/property.dto.js';
export * from './dto/property-config.dto.js';
