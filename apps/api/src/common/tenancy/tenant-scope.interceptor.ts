/**
 * Runs each request's handler inside its tenant scope (MT-02).
 *
 * ===========================================================================
 * The guards decide the property (the session guard from the route's
 * `:hotelId` / `:propertyId`, the active-property guard from a verified
 * grant) and record it on the request. They cannot bind it themselves: a
 * guard is awaited by Nest, and an AsyncLocalStorage binding made inside an
 * awaited function does not survive into the caller's continuation, so the
 * handler would run unscoped. An interceptor wraps the handler instead, and
 * everything the handler awaits inherits the scope.
 *
 * Registered globally, so it is the outermost interceptor; a route marked
 * `@CrossProperty` wraps the handler again in a logged bypass, which wins.
 * ===========================================================================
 */

import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { runInPropertyScope } from '@repo/database';
import { Observable } from 'rxjs';

/** Where the guards leave the verified property for this interceptor. */
export const TENANT_PROPERTY_KEY = 'easeitTenantPropertyId';

export function setRequestTenant(request: unknown, propertyId: string): void {
  (request as Record<string, unknown>)[TENANT_PROPERTY_KEY] = propertyId;
}

@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const propertyId = request[TENANT_PROPERTY_KEY];
    if (typeof propertyId !== 'string') return next.handle();
    return new Observable((subscriber) =>
      runInPropertyScope(propertyId, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => {
          subscription.unsubscribe();
        };
      }),
    );
  }
}
