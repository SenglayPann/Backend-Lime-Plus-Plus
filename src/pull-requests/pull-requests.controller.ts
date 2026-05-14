import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PullRequestsService } from './pull-requests.service';
import { ListPullRequestsQueryDto } from './dto/list-pull-requests-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

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
    @Query() query: ListPullRequestsQueryDto,
    @Request() req?: RequestWithUser,
  ) {
    return this.prService.findAll(
      req!.user.id,
      req!.user.roles,
      projectId,
      query.assignee_id,
      query.status,
    );
  }

  @Get('pull-requests/:id/validate')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({
    summary: 'Validate a pull request task-linkage (Project Members+)',
  })
  async validate(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.prService.validateLink(id, req.user.id, req.user.roles);
  }
}
