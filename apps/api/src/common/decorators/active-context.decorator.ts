/**
 * Injects the resolved `ActivePropertyContext` into a handler parameter, so a
 * controller never reaches into the raw request to find the tenant.
 *
 *   list(@ActiveContext() context: ActivePropertyContext) { ... }
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ActivePropertyContext } from '@repo/types';

import type { AuthenticatedRequest } from '../auth/authenticated-user.js';

export const ActiveContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ActivePropertyContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const active = request.activePropertyContext;
    if (active === undefined) {
      throw new Error('@ActiveContext() used on a route without ActivePropertyGuard.');
    }
    return active;
  },
);
