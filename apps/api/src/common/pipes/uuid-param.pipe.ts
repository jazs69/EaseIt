/**
 * Route identifiers that are not UUIDs are not found.
 *
 * ===========================================================================
 * Every `:somethingId` route parameter except `:hotelId` names a UUID primary
 * key. Passed through raw, a malformed one reaches PostgreSQL's `::uuid` cast
 * or Prisma's UUID column and comes back as a driver error -- which the global
 * filter correctly refuses to describe, so the caller saw a 500 for what is
 * simply a record that cannot exist. That was observed on
 * `PATCH .../pricing-rules/undefined/status`.
 *
 * Answered as 404 NOT_FOUND, the same as a well-formed id that matches
 * nothing, so the response never distinguishes "malformed" from "absent" or
 * "another property's" (section 3.2).
 *
 * `:hotelId` is excluded because it deliberately accepts a property CODE as
 * well as an id; its resolver already answers not-found for both.
 * ===========================================================================
 */

import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';

import { EntityNotFoundError } from '../errors/domain-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Params named like an id that are NOT UUIDs by design. */
const EXEMPT = new Set(['hotelId']);

@Injectable()
export class UuidParamPipe implements PipeTransform<unknown, unknown> {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'param') return value;
    const name = metadata.data;
    if (name === undefined || EXEMPT.has(name) || !name.endsWith('Id')) return value;
    if (typeof value === 'string' && UUID.test(value)) return value;
    throw new EntityNotFoundError('Resource');
  }
}
