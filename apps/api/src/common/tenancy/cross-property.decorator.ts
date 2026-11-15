/**
 * `@CrossProperty(reason)` -- a route whose reads span properties by nature
 * (MT-08): sign-in and session resolution, the portfolio dashboards, the
 * outbox gauge. The handler runs inside `withoutTenantScope(reason)`, which is
 * logged; everything else in the API is confined to one property by the auth
 * guard. Used sparingly, and only where crossing properties is the point:
 * these handlers still filter by the caller's own grants.
 */

import {
  applyDecorators,
  Injectable,
  SetMetadata,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withoutTenantScope } from '@repo/database';
import { Observable } from 'rxjs';

const CROSS_PROPERTY_REASON = 'easeit:cross-property-reason';

@Injectable()
export class CrossPropertyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const reason =
      this.reflector.get<string | undefined>(CROSS_PROPERTY_REASON, context.getHandler()) ??
      this.reflector.get<string | undefined>(CROSS_PROPERTY_REASON, context.getClass()) ??
      'cross-property route';
    // Subscribing inside the scope runs the handler -- and its whole async
    // chain -- with the bypass bound.
    return new Observable((subscriber) =>
      withoutTenantScope(reason, () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => {
          subscription.unsubscribe();
        };
      }),
    );
  }
}

export function CrossProperty(reason: string): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(CROSS_PROPERTY_REASON, reason), UseInterceptors(CrossPropertyInterceptor));
}
