import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { Roles } from '../decorators/roles.decorator';
import { Role, AuditAction } from '../../generated/prisma';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import type { RequestWithUser } from '../types/request.interface';

@ApiTags('Audit Logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'List scoped audit logs' })
  @ApiQuery({ name: 'project_id', required: false })
  @ApiQuery({ name: 'actor_id', required: false })
  @ApiQuery({ name: 'action', required: false })
  async findAll(
    @Request() req: RequestWithUser,
    @Query('project_id') projectId?: string,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
  ) {
    return this.auditService.findAll(
      req.user.id,
      req.user.roles,
      projectId,
      actorId,
      action as AuditAction | undefined,
    );
  }
}
