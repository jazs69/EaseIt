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
export * from './dto/folio.dto.js';
export * from './dto/group.dto.js';
export * from './dto/check-in.dto.js';
export * from './dto/create-reservation.dto.js';
export * from './dto/performance.dto.js';
export * from './dto/reports.dto.js';
export * from './dto/reservation-detail.dto.js';
export * from './dto/reservation-search.dto.js';
export * from './dto/property-dashboard.dto.js';
export * from './dto/timeline.dto.js';
export * from './dto/property.dto.js';
