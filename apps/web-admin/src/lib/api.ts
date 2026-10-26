/**
 * The typed fetch boundary between the admin app and `apps/api`.
 *
 * Two rules this file exists to enforce:
 *
 *   1. **Every response is parsed with the schema from @repo/types**, not
 *      cast. `as LoginResult` would compile against a server that has since
 *      changed shape and then fail somewhere far from the cause; parsing fails
 *      here, at the boundary, with the field named (CLAUDE.md section 5).
 *   2. **Errors arrive as the API's own `{ code, message, requestId }`
 *      envelope**, surfaced as a typed `ApiRequestError` the UI can branch on
 *      by `code`. No component builds a message out of an HTTP status.
 *
 * `credentials: 'include'` is on every call, because the session is an
 * httpOnly cookie on a different origin and is otherwise simply not sent.
 */

import { apiErrorSchema, ErrorCode, type ApiError } from '@repo/types';
import type { ZodType } from 'zod';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Everything lives under the global prefix and URI version set in main.ts. */
const API_PREFIX = '/api/v1';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(status: number, body: Partial<ApiError>) {
    super(body.message ?? 'The request could not be completed.');
    this.name = 'ApiRequestError';
    this.code = body.code ?? ErrorCode.INTERNAL_ERROR;
    this.status = status;
    this.details = body.details;
    this.requestId = body.requestId;
  }

  /** Reads a numeric hint the API attached, e.g. `retryAfterSeconds`. */
  detail(key: string): number | undefined {
    const value = this.details?.[key];
    return typeof value === 'number' ? value : undefined;
  }
}

/** The network itself failed — no response, so no code to branch on. */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super('Could not reach the EaseIt API. Check that it is running.');
    this.name = 'ApiUnreachableError';
    this.cause = cause;
  }
}

export interface ApiFetchOptions {
  // PUT is here for the one endpoint that genuinely replaces a whole
  // collection — the GST slab table, which is only valid as a set.
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Forwarded server-side, where there is no browser to attach the cookie. */
  cookieHeader?: string;
  signal?: AbortSignal;
}

/**
 * Performs the request and parses the result with `schema`.
 *
 * Pass `null` as the schema for an endpoint that returns no body (204).
 */
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T>,
  options?: ApiFetchOptions,
): Promise<T>;
export async function apiFetch(
  path: string,
  schema: null,
  options?: ApiFetchOptions,
): Promise<void>;
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T> | null,
  options: ApiFetchOptions = {},
): Promise<T | void> {
  const { method = 'GET', body, cookieHeader, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${API_PREFIX}${path}`, {
      method,
      // Sends the httpOnly session cookie cross-origin. The API's CORS
      // allowlist names this origin explicitly, which is required whenever
      // credentials ride along.
      credentials: 'include',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        accept: 'application/json',
        // Server components have no ambient cookie jar, so the caller
        // forwards the incoming request's own Cookie header.
        ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
      // A session or a sign-in result must never come from a cache.
      cache: 'no-store',
    });
  } catch (cause) {
    // Distinguished from an API error on purpose: "the API is down" and "your
    // code was wrong" need different copy, and conflating them produces the
    // classic "something went wrong" dead end.
    throw new ApiUnreachableError(cause);
  }

  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorBody(response));
  }

  if (schema === null) return;

  const payload: unknown = await response.json();
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    // A contract mismatch is a bug on one side or the other. Reported as such
    // rather than crashing a component on a missing field.
    throw new ApiRequestError(response.status, {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'The API returned a response this client does not understand.',
      details: { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
    });
  }

  return parsed.data;
}

async function readErrorBody(response: Response): Promise<Partial<ApiError>> {
  try {
    const payload: unknown = await response.json();
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) return parsed.data;

    // Not our envelope — a proxy error page, or a framework-level 404.
    return {
      code: response.status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.INTERNAL_ERROR,
      message: 'The API returned an unexpected error.',
    };
  } catch {
    return { code: ErrorCode.INTERNAL_ERROR, message: 'The API returned an unreadable error.' };
  }
}
