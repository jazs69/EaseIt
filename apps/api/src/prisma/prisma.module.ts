import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';

/**
 * Global so that feature modules do not each have to import it. This is the
 * one acceptable use of @Global in this codebase: a single infrastructure
 * provider with no domain behaviour.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
