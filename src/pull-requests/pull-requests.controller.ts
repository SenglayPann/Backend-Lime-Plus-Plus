import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PullRequestsService } from './pull-requests.service';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

@ApiTags('Pull Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class PullRequestsController {
  constructor(private readonly prService: PullRequestsService) {}

  @Get('projects/:projectId/pull-requests')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({
    summary: 'List pull requests for a project (Project Members+)',
  })
  @ApiQuery({ name: 'assignee_id', required: false })
  @ApiQuery({ name: 'status', required: false })
  async findAll(
    @Param('projectId') projectId: string,
    @Query('assignee_id') assigneeId?: string,
    @Query('status') status?: string,
  ) {
    return this.prService.findAll(projectId, assigneeId, status);
  }

  @Get('pull-requests/:id/validate')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({
    summary: 'Validate a pull request task-linkage (Project Members+)',
  })
  async validate(@Param('id') id: string) {
    return this.prService.validateLink(id);
  }
}
