import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RoleDefinitionDto } from '@repo/types';

import { RbacService } from './rbac.service.js';

@ApiTags('rbac')
@Controller('rbac')
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('roles')
  @ApiOperation({
    summary: 'The role catalog with the permissions each role grants',
  })
  @ApiOkResponse({ description: 'All six system roles and their permission sets.' })
  listRoles(): RoleDefinitionDto[] {
    return this.rbac.listRoles();
  }
}
