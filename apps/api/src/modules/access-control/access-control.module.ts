import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { TokenService } from '../../common/auth/token.service.js';
import { ActivePropertyGuard } from '../../common/guards/active-property.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { AccessControlController } from './access-control.controller.js';
import { AccessControlRepository } from './access-control.repository.js';
import { AccessControlService } from './access-control.service.js';

/**
 * RBAC management.
 *
 * The guards are provided here rather than registered globally: most routes
 * in this API are not property-scoped (health, sign-in, the public booking
 * engine), and a global ActivePropertyGuard would reject them.
 *
 * SessionAuthGuard and TokenService are re-provided rather than imported from
 * AuthModule to keep the dependency one-directional: access control is
 * downstream of authentication, and importing the module that owns the login
 * routes just to borrow a guard would invert that. Both are stateless.
 */
@Module({
  controllers: [AccessControlController],
  providers: [
    AccessControlService,
    AccessControlRepository,
    SessionAuthGuard,
    TokenService,
    ActivePropertyGuard,
    PermissionsGuard,
  ],
  exports: [AccessControlService],
})
export class AccessControlModule {}
