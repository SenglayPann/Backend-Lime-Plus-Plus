import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { Roles } from '../decorators/roles.decorator';
import { Role } from '../../generated/prisma';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';

@ApiTags('Audit Logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List system audit logs (Admin only)' })
  @ApiQuery({ name: 'project_id', required: false })
  @ApiQuery({ name: 'actor_id', required: false })
  @ApiQuery({ name: 'action', required: false })
  async findAll(
    @Query('project_id') projectId?: string,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
  ) {
    return this.auditService.findAll(projectId, actorId, action);
  }
}
