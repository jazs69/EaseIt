/**
 * Group dashboard data access.
 *
 * `fetchMyGroup` is called from a server component with the incoming request's
 * cookie forwarded; `selectPropertyContext` is called from the browser when an
 * operator picks a property. The split matters: the list is rendered on the
 * server so the first paint already has data, and only the *choice* is a
 * client interaction.
 */

import {
  checkInPreflightSchema,
  folioPageSchema,
  reservationDetailSchema,
  reservationNoteSchema,
  checkInResultSchema,
  groupCalendarResponseSchema,
  groupPerformanceSchema,
  groupPropertiesResponseSchema,
  companySummarySchema,
  createdReservationSchema,
  gstinLookupSchema,
  postalLookupSchema,
  reportResponseSchema,
  reservationQuoteSchema,
  reservationSearchResponseSchema,
  propertyDashboardSchema,
  timelineCalendarSchema,
  selectPropertyContextResponseSchema,
  type DashboardMetric,
  type GroupCalendarResponse,
  type GroupPerformance,
  type GroupPropertiesResponse,
  type ListGroupPropertiesQuery,
  type PerformanceTimeframe,
  type PropertyDashboard,
  type PropertyStatusFilter,
  type CompanySummary,
  type CreateCompanyCommand,
  type FolioPage,
  type PostFolioChargeCommand,
  type PostFolioDiscountCommand,
  type PostFolioPaymentCommand,
  type AddReservationNoteCommand,
  type ReservationDetail,
  type ReservationNoteView,
  type CheckInPreflight,
  type CheckInRequest,
  type CheckInResult,
  type CreatedReservation,
  type GstinLookup,
  type PostalLookup,
  type CreateReservationCommand,
  type ReportResponse,
  type ReservationQuote,
  type ReservationQuoteRequest,
  type ReportType,
  type ReservationSearchResponse,
  type TimelineCalendar,
  type TimelineTimeframe,
  type TimelineViewMode,
  type SelectPropertyContextResponse,
} from '@repo/types';

import { z } from 'zod';

import { API_BASE_URL, apiFetch } from './api';

export interface FetchMyGroupOptions {
  status?: PropertyStatusFilter;
  search?: string;
  /** Required server-side: a server component has no ambient cookie jar. */
  cookieHeader?: string;
}

export function fetchMyGroup(
  options: FetchMyGroupOptions = {},
): Promise<GroupPropertiesResponse> {
  const params = new URLSearchParams();
  if (options.status !== undefined) params.set('status', options.status);
  if (options.search !== undefined && options.search.length > 0) {
    params.set('search', options.search);
  }

  const query = params.size === 0 ? '' : `?${params.toString()}`;

  return apiFetch(`/properties/my-group${query}`, groupPropertiesResponseSchema, {
    ...(options.cookieHeader === undefined ? {} : { cookieHeader: options.cookieHeader }),
  });
}

/**
 * Sets the caller's active property.
 *
 * The API answers with a re-issued session cookie carrying the choice. Nothing
 * is stored client-side: an `active_property_id` cookie written here would be
 * a tenant identifier the browser asserts, and the browser can edit its own
 * cookies (CLAUDE.md section 3.2). The signed session is the only carrier, and
 * the API re-verifies the grant on every request regardless.
 */
export function selectPropertyContext(
  propertyId: string,
): Promise<SelectPropertyContextResponse> {
  return apiFetch('/properties/select-context', selectPropertyContextResponseSchema, {
    method: 'POST',
    body: { propertyId },
  });
}

/** Narrows a URL search param to the filter union, falling back to ACTIVE. */
export function parseStatusFilter(raw: string | undefined): PropertyStatusFilter {
  if (raw === 'ALL' || raw === 'ACTIVE' || raw === 'ONBOARDING' || raw === 'INACTIVE') {
    return raw;
  }
  return 'ACTIVE';
}

export type { ListGroupPropertiesQuery };

/* -------------------------------------------------------------------------- */
/*  Property operations dashboard                                             */
/* -------------------------------------------------------------------------- */

export interface FetchPropertyDashboardOptions {
  /** Property code (31336) or uuid. Verified against the caller's grants. */
  hotelId: string;
  metric?: DashboardMetric;
  /** `YYYY-MM-DD`. Omitted means the property's own business date. */
  date?: string;
  cookieHeader?: string;
}

/**
 * The whole daily dashboard in one request.
 *
 * One call rather than one per widget: the counts, the feed and the
 * availability table are read together and have to agree with each other, and
 * separate requests can each resolve against a different instant.
 */
export function fetchPropertyDashboard(
  options: FetchPropertyDashboardOptions,
): Promise<PropertyDashboard> {
  const params = new URLSearchParams();
  if (options.metric !== undefined) params.set('metric', options.metric);
  if (options.date !== undefined) params.set('date', options.date);

  const query = params.size === 0 ? '' : `?${params.toString()}`;

  return apiFetch(
    `/properties/${encodeURIComponent(options.hotelId)}/dashboard-summary${query}`,
    propertyDashboardSchema,
    {
      ...(options.cookieHeader === undefined ? {} : { cookieHeader: options.cookieHeader }),
    },
  );
}

/** Narrows a URL search param to the metric union, defaulting to in-house. */
export function parseMetric(raw: string | undefined): DashboardMetric {
  const allowed: readonly DashboardMetric[] = [
    'NEW_BOOKINGS',
    'IN_HOUSE',
    'ARRIVALS',
    'DEPARTURES',
    'CANCELLATIONS',
    'ON_HOLD',
    'NO_SHOWS',
    'MAGIC_LINK',
  ];
  return allowed.find((metric) => metric === raw) ?? 'IN_HOUSE';
}

/** `YYYY-MM-DD` or undefined. Anything else is ignored rather than trusted. */
export function parseIsoDate(raw: string | undefined): string | undefined {
  return raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

/* -------------------------------------------------------------------------- */
/*  Group reservation calendar                                                */
/* -------------------------------------------------------------------------- */

export interface FetchGroupCalendarOptions {
  /** `YYYY-MM-DD`. Omitted means the reference property's business date. */
  startDate?: string;
  endDate?: string;
  /** Narrows to a subset of the caller's own properties. */
  propertyIds?: readonly string[];
  cookieHeader?: string;
}

export function fetchGroupCalendar(
  options: FetchGroupCalendarOptions = {},
): Promise<GroupCalendarResponse> {
  const params = new URLSearchParams();
  if (options.startDate !== undefined) params.set('startDate', options.startDate);
  if (options.endDate !== undefined) params.set('endDate', options.endDate);
  if (options.propertyIds !== undefined && options.propertyIds.length > 0) {
    params.set('propertyIds', options.propertyIds.join(','));
  }

  const query = params.size === 0 ? '' : `?${params.toString()}`;

  return apiFetch(`/properties/group-calendar${query}`, groupCalendarResponseSchema, {
    ...(options.cookieHeader === undefined ? {} : { cookieHeader: options.cookieHeader }),
  });
}

/* -------------------------------------------------------------------------- */
/*  Timeline reservation calendar                                             */
/* -------------------------------------------------------------------------- */

export interface FetchTimelineOptions {
  /** Property code (31336) or uuid. Verified against the caller's grants. */
  hotelId: string;
  /** `YYYY-MM-DD`. Omitted means the property's own business date. */
  startDate?: string;
  timeframe?: TimelineTimeframe;
  viewMode?: TimelineViewMode;
  roomTypeId?: string;
  floor?: string;
  housekeeping?: string;
  cookieHeader?: string;
}

/**
 * The whole grid in one request.
 *
 * One call rather than one per widget: the date axis, the blocks and the
 * sold/available rollups above and below them must agree with each other, and
 * separate requests can each resolve against a different instant.
 */
export function fetchTimelineCalendar(
  options: FetchTimelineOptions,
): Promise<TimelineCalendar> {
  const params = new URLSearchParams();
  if (options.startDate !== undefined) params.set('startDate', options.startDate);
  if (options.timeframe !== undefined) params.set('timeframe', options.timeframe);
  if (options.viewMode !== undefined) params.set('viewMode', options.viewMode);
  if (options.roomTypeId !== undefined) params.set('roomTypeId', options.roomTypeId);
  if (options.floor !== undefined) params.set('floor', options.floor);
  if (options.housekeeping !== undefined) params.set('housekeeping', options.housekeeping);

  const query = params.size === 0 ? '' : `?${params.toString()}`;

  return apiFetch(
    `/properties/${encodeURIComponent(options.hotelId)}/timeline-calendar${query}`,
    timelineCalendarSchema,
    { ...(options.cookieHeader === undefined ? {} : { cookieHeader: options.cookieHeader }) },
  );
}

/**
 * Narrows a `timeframe` param to the switcher's four stops.
 *
 * A union rather than a day count, because `day` is not "one day column" — it
 * is twenty-four hour columns, which is a different axis. A number could not
 * express that.
 */
export function parseTimeframe(raw: string | undefined): TimelineTimeframe {
  return raw === 'day' || raw === 'week' || raw === 'ten_days' || raw === 'month'
    ? raw
    : 'week';
}

export function parseViewMode(raw: string | undefined): TimelineViewMode {
  return raw === 'by-category' ? 'by-category' : 'flat';
}

/* -------------------------------------------------------------------------- */
/*  Group performance analytics                                               */
/* -------------------------------------------------------------------------- */

export interface FetchGroupPerformanceOptions {
  timeframe?: PerformanceTimeframe;
  /** `YYYY-MM-DD`. Omitted means the reference property's business date. */
  targetDate?: string;
  propertyIds?: readonly string[];
  /** Also compute the same window one year earlier. */
  compareWithLastYear?: boolean;
  cookieHeader?: string;
}

/**
 * Every figure on the performance screen in one request.
 *
 * The KPI cards, the rankings, the monthly chart and the per-property table are
 * four views of one window, and they have to agree: a table whose revenue
 * column does not sum to the headline figure is worse than no table. Separate
 * requests could each resolve against a different business date — this one
 * resolves it once, server-side.
 */
export function fetchGroupPerformance(
  options: FetchGroupPerformanceOptions = {},
): Promise<GroupPerformance> {
  const params = new URLSearchParams();
  if (options.timeframe !== undefined) params.set('timeframe', options.timeframe);
  if (options.targetDate !== undefined) params.set('targetDate', options.targetDate);
  if (options.propertyIds !== undefined && options.propertyIds.length > 0) {
    params.set('propertyIds', options.propertyIds.join(','));
  }
  if (options.compareWithLastYear === true) params.set('compareWithLastYear', 'true');

  const query = params.size === 0 ? '' : `?${params.toString()}`;

  return apiFetch(`/properties/group-performance${query}`, groupPerformanceSchema, {
    ...(options.cookieHeader === undefined ? {} : { cookieHeader: options.cookieHeader }),
  });
}

/** Narrows a `timeframe` param to the three stops the API accepts. */
export function parsePerformanceTimeframe(raw: string | undefined): PerformanceTimeframe {
  return raw === 'today' || raw === 'mtd' || raw === 'ytd' ? raw : 'ytd';
}

/* -------------------------------------------------------------------------- */
/*  Omnibar reservation search                                                */
/* -------------------------------------------------------------------------- */

export interface SearchReservationsOptions {
  /** Property code (31336) or uuid. Verified against the caller's grants. */
  hotelId: string;
  /** At least 2 characters; the API rejects shorter. */
  q: string;
  limit?: number;
  /** An AbortSignal, so a superseded keystroke's request is cancelled. */
  signal?: AbortSignal;
}

/**
 * Called from the browser, on every debounced keystroke.
 *
 * No `cookieHeader`: in the browser `apiFetch` sends the httpOnly session with
 * `credentials: 'include'`, which is the only way it can — page scripts cannot
 * read that cookie, which is the point of it being httpOnly.
 */
export function searchReservations(
  options: SearchReservationsOptions,
): Promise<ReservationSearchResponse> {
  const params = new URLSearchParams({ q: options.q });
  if (options.limit !== undefined) params.set('limit', String(options.limit));

  return apiFetch(
    `/properties/${encodeURIComponent(options.hotelId)}/reservations/search?${params.toString()}`,
    reservationSearchResponseSchema,
    { ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
}

/* -------------------------------------------------------------------------- */
/*  Property reports                                                          */
/* -------------------------------------------------------------------------- */

export interface FetchReportOptions {
  hotelId: string;
  type: ReportType;
  /** `YYYY-MM-DD`. Omitted means the property's own business date. */
  startDate?: string;
  endDate?: string;
  cookieHeader?: string;
}

export function fetchReport(options: FetchReportOptions): Promise<ReportResponse> {
  const params = new URLSearchParams();
  if (options.startDate !== undefined) params.set('startDate', options.startDate);
  if (options.endDate !== undefined) params.set('endDate', options.endDate);
  const query = params.size === 0 ? '' : `?${params.toString()}`;

  return apiFetch(
    `/properties/${encodeURIComponent(options.hotelId)}/reports/${options.type}${query}`,
    reportResponseSchema,
    { ...(options.cookieHeader === undefined ? {} : { cookieHeader: options.cookieHeader }) },
  );
}

/**
 * The CSV download URL for a report.
 *
 * A plain link rather than a fetch-and-blob: the browser's own download
 * machinery handles the Content-Disposition header, shows progress, and puts
 * the file where the user expects it. Fetching it into memory first would
 * reimplement all of that and lose the filename the server chose.
 *
 * The session travels as the httpOnly cookie on an ordinary navigation, which
 * is why this works without attaching anything.
 */
export function reportCsvUrl(options: FetchReportOptions): string {
  const params = new URLSearchParams({ format: 'csv' });
  if (options.startDate !== undefined) params.set('startDate', options.startDate);
  if (options.endDate !== undefined) params.set('endDate', options.endDate);

  return `${API_BASE_URL}/api/v1/properties/${encodeURIComponent(options.hotelId)}/reports/${options.type}?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/*  Creating a reservation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Prices a stay. Advisory only — it reserves nothing.
 *
 * Called from the form on every change so the figures on screen are the ones
 * the server will charge. The booking recomputes them inside its transaction,
 * so a quote that goes stale between here and submit cannot become a wrong
 * charge; it can only become a refusal.
 */
export function quoteReservation(
  hotelId: string,
  body: ReservationQuoteRequest,
  signal?: AbortSignal,
): Promise<ReservationQuote> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/reservations/quote`,
    reservationQuoteSchema,
    { method: 'POST', body, ...(signal === undefined ? {} : { signal }) },
  );
}

export function createReservation(
  hotelId: string,
  body: CreateReservationCommand,
): Promise<CreatedReservation> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/reservations`,
    createdReservationSchema,
    { method: 'POST', body },
  );
}

/* -------------------------------------------------------------------------- */
/*  Folio and billing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The billing page, by the booking code a clerk reads aloud.
 *
 * Scoped by `hotelId`: the code is unique per property, so the same code at
 * another hotel is a different booking and the API refuses it.
 */
export function fetchFolioPage(
  hotelId: string,
  bookingCode: string,
  options?: { signal?: AbortSignal; cookieHeader?: string },
): Promise<FolioPage> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/folios/by-booking/${encodeURIComponent(bookingCode)}`,
    folioPageSchema,
    {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.cookieHeader === undefined ? {} : { cookieHeader: options.cookieHeader }),
    },
  );
}

/**
 * Each posting returns the whole recomputed page.
 *
 * Not the created line: the balance and every total are derived from the
 * ledger, so a client that patched one line into local state would have to
 * re-derive all of them — and would eventually re-derive one differently
 * (CLAUDE.md section 3.4).
 */
export function postFolioPayment(
  hotelId: string,
  folioId: string,
  body: PostFolioPaymentCommand,
): Promise<FolioPage> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/folios/${encodeURIComponent(folioId)}/payment`,
    folioPageSchema,
    { method: 'POST', body },
  );
}

export function postFolioCharge(
  hotelId: string,
  folioId: string,
  body: PostFolioChargeCommand,
): Promise<FolioPage> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/folios/${encodeURIComponent(folioId)}/charge`,
    folioPageSchema,
    { method: 'POST', body },
  );
}

export function postFolioDiscount(
  hotelId: string,
  folioId: string,
  body: PostFolioDiscountCommand,
): Promise<FolioPage> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/folios/${encodeURIComponent(folioId)}/discount`,
    folioPageSchema,
    { method: 'POST', body },
  );
}

/* -------------------------------------------------------------------------- */
/*  Reservation detail                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The drawer's own fetch.
 *
 * Deliberately not folded into the timeline payload: the grid returns a block
 * per stay in the window, and attaching every guest row, folio line and note
 * to all of them to serve the one a clerk might click would overfetch by two
 * orders of magnitude (CLAUDE.md section 5).
 */
export function fetchReservationDetail(
  hotelId: string,
  reservationId: string,
  signal?: AbortSignal,
): Promise<ReservationDetail> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/reservations/${encodeURIComponent(reservationId)}`,
    reservationDetailSchema,
    signal === undefined ? undefined : { signal },
  );
}

export function addReservationNote(
  hotelId: string,
  reservationId: string,
  body: AddReservationNoteCommand,
): Promise<ReservationNoteView> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/reservations/${encodeURIComponent(reservationId)}/notes`,
    reservationNoteSchema,
    { method: 'POST', body },
  );
}

/* -------------------------------------------------------------------------- */
/*  Check-in                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the check-in modal needs, before it commits to anything.
 *
 * The blockers it returns are advisory in exactly the way a quote is: the
 * write path re-derives every one of them inside its transaction, so a room
 * that was clean when the modal opened and dirty by the time the clerk pressed
 * the button is refused there rather than let through here.
 */
export function fetchCheckInPreflight(
  hotelId: string,
  reservationId: string,
  signal?: AbortSignal,
): Promise<CheckInPreflight> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/reservations/${encodeURIComponent(reservationId)}/check-in`,
    checkInPreflightSchema,
    signal === undefined ? undefined : { signal },
  );
}

export function checkInReservation(
  hotelId: string,
  reservationId: string,
  body: CheckInRequest,
): Promise<CheckInResult> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/reservations/${encodeURIComponent(reservationId)}/check-in`,
    checkInResultSchema,
    { method: 'POST', body },
  );
}

/* -------------------------------------------------------------------------- */
/*  Companies and booking-form lookups                                        */
/* -------------------------------------------------------------------------- */


export function listCompanies(hotelId: string): Promise<CompanySummary[]> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/companies`,
    z.array(companySummarySchema),
  );
}

export function createCompany(
  hotelId: string,
  body: CreateCompanyCommand,
): Promise<CompanySummary> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/companies`,
    companySummarySchema,
    { method: 'POST', body },
  );
}

/** Offline GSTIN check: structure plus the number's own check digit. */
export function lookupGstin(
  hotelId: string,
  gstin: string,
  signal?: AbortSignal,
): Promise<GstinLookup> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/lookups/gstin?gstin=${encodeURIComponent(gstin)}`,
    gstinLookupSchema,
    { ...(signal === undefined ? {} : { signal }) },
  );
}

/**
 * City and state for a PIN code.
 *
 * Never rejects for an unknown code: the response carries `found: false` and
 * the form falls back to manual entry, because a slow postal service must not
 * be able to block a booking.
 */
export function lookupPostalCode(
  hotelId: string,
  postalCode: string,
  signal?: AbortSignal,
): Promise<PostalLookup> {
  return apiFetch(
    `/properties/${encodeURIComponent(hotelId)}/lookups/postal-code?postalCode=${encodeURIComponent(postalCode)}`,
    postalLookupSchema,
    { ...(signal === undefined ? {} : { signal }) },
  );
}
