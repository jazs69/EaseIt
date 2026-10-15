/**
 * Request-scoped tenant context (CLAUDE.md section 3.2).
 *
 * The active `propertyId` is established once per request by a guard — from
 * the authenticated session for staff, or from the resolved slug for the
 * public booking engine — and read from here by every repository.
 *
 * It is never read from a client-supplied header, body field or query
 * parameter. AsyncLocalStorage is used rather than a REQUEST-scoped provider
 * so that services which are not themselves request-scoped (BullMQ workers,
 * repositories) can still reach it without threading it through every call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';
import type { AuthSubject, PropertyId } from '@repo/types';

export interface PropertyContext {
  /** The tenant this request operates on. Null only for portfolio-level work. */
  readonly propertyId: PropertyId | null;
  readonly subject: AuthSubject | null;
  readonly requestId: string;
}

@Injectable()
export class PropertyContextService {
  private readonly storage = new AsyncLocalStorage<PropertyContext>();

  /** Runs `work` with `context` bound for its entire async subtree. */
  run<T>(context: PropertyContext, work: () => T): T {
    return this.storage.run(context, work);
  }

  /** The current context, or null outside a request (e.g. during bootstrap). */
  peek(): PropertyContext | null {
    return this.storage.getStore() ?? null;
  }

  /**
   * The active property, asserted. Repositories use this: reaching a
   * tenant-scoped query with no context is a programming error, and failing
   * loudly here is far better than silently querying across all ten hotels.
   */
  requirePropertyId(): PropertyId {
    const context = this.storage.getStore();
    if (!context) {
      throw new Error(
        'No property context is bound. A tenant-scoped query ran outside a ' +
          'request, or PropertyScopeGuard did not run for this route.',
      );
    }
    if (context.propertyId === null) {
      throw new Error(
        'This request is portfolio-scoped and has no active property. Use ' +
          'withoutTenantScope() deliberately if a cross-property read is intended.',
      );
    }
    return context.propertyId;
  }

  requireSubject(): AuthSubject {
    const subject = this.storage.getStore()?.subject;
    if (!subject) {
      throw new Error('No authenticated subject is bound to this request.');
    }
    return subject;
  }
}
