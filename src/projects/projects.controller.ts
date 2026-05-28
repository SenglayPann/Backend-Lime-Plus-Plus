import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Sse,
  MessageEvent,
  UseGuards,
  Request,
  Headers,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { AttachGitHubDto } from './dto/attach-github.dto';
import { UpsertProjectMemberDto } from './dto/upsert-project-member.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ProjectAccessService } from '../common/access/project-access.service';
import { ProjectEventsService } from '../github/project-events.service';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly projectEventsService: ProjectEventsService,
  ) {}

  @Post()
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Create a new project (Dept Manager/Project Manager)' })
  async create(
    @Body() createProjectDto: CreateProjectDto,
    @Request() req: RequestWithUser,
    @Headers('x-github-token') githubToken?: string,
  ) {
    return this.projectsService.create(
      createProjectDto,
      req.user.id,
      req.user.roles,
      githubToken,
    );
  }

  @Get()
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'List accessible projects (Project Member+)' })
  @ApiQuery({ name: 'department_id', required: false })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by project, repository, department, organization, or status',
  })
  async findAll(
    @Query('department_id') departmentId: string | undefined,
    @Query('search') search: string | undefined,
    @Request() req: RequestWithUser,
  ) {
    return this.projectsService.findAll(
      departmentId,
      req.user.id,
      req.user.roles,
      search,
    );
  }

  @Get(':id')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'Get project details' })
  async findOne(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.projectsService.findOne(id, req.user.id, req.user.roles);
  }

  /**
   * Server-Sent Events stream for live project updates.
   *
   * Auth caveat: the browser EventSource API cannot set custom headers, so
   * the JWT is passed via the `access_token` query parameter — accepted by
   * the JwtStrategy as a fallback. This widens token exposure (web-server
   * access logs, browser history, referer headers on any redirect), so the
   * token's short TTL (15 min) and same-origin scope are doing real work
   * here. If we ever want to narrow that surface, the next step is a
   * short-lived single-use ticket: client POSTs to a `/events/ticket`
   * endpoint, gets back a 60-second one-shot token, then opens the SSE
   * stream with that ticket. See follow-up TODO in project-events.service.
   *
   * Subscribers are filtered to a single project channel by the path
   * param. A periodic recheck terminates the stream if the actor loses
   * access to the project (e.g. their role is revoked) so the leak
   * window after revocation is bounded to RECHECK_MS instead of the JWT
   * TTL.
   */
  @Sse(':id/events')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'Subscribe to live project updates (SSE)' })
  async streamProjectEvents(
    @Param('id') id: string,
    @Request() req: RequestWithUser,
  ): Promise<Observable<MessageEvent>> {
    await this.projectAccessService.assertCanViewProject(
      req.user.id,
      req.user.roles,
      id,
    );
    return this.projectEventsService.stream(id, {
      recheck: () =>
        this.projectAccessService
          .assertCanViewProject(req.user.id, req.user.roles, id)
          .then(() => true)
          .catch(() => false),
    });
  }

  @Get(':id/members')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'List project members' })
  async listMembers(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.projectsService.listMembers(id, req.user.id, req.user.roles);
  }

  @Post(':id/members')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Add or update a project member' })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async upsertMember(
    @Param('id') id: string,
    @Body() dto: UpsertProjectMemberDto,
    @Request() req: RequestWithUser,
  ) {
    return this.projectsService.upsertMember(
      id,
      dto.user_id,
      dto.role || Role.PROJECT_MEMBER,
      req.user.id,
      req.user.roles,
    );
  }

  @Delete(':id/members/:memberId')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Remove a project member' })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async removeMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Request() req: RequestWithUser,
  ) {
    return this.projectsService.removeMember(
      id,
      memberId,
      req.user.id,
      req.user.roles,
    );
  }

  @Post(':id/lock')
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Lock project for grading (Dept Manager+)' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async lock(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.projectsService.lockProject(id, req.user.id, req.user.roles);
  }

  @Post(':id/tasks/sync')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Manual sync tasks from GitHub (Project Manager+)' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async syncTasks(@Param('id') id: string, @Request() req: RequestWithUser) {
    // In a real app, the accessToken would come from the user's session or GitHub App token
    // For now, we'll assume it's passed or available.
    // We might need to fetch it from the database or GitHubService.

    // Note: The spec says this expects an accessToken.
    // If not provided in body, we might need to get it from the user's OAuth record.
    const accessTokenHeader = req.headers['x-github-token'];
    const accessToken =
      (Array.isArray(accessTokenHeader)
        ? accessTokenHeader[0]
        : accessTokenHeader) ||
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
      '';

    return this.projectsService.syncTasks(
      id,
      accessToken,
      req.user.id,
      req.user.roles,
    );
  }

  @Patch(':id/attach-github')
  @Roles(Role.PROJECT_MANAGER, Role.PROJECT_LEAD)
  @ApiOperation({ summary: 'Attach a GitHub repository and Project V2 (Project Manager/Lead)' })
  async attachGithub(
    @Param('id') id: string,
    @Body() attachGitHubDto: AttachGitHubDto,
    @Request() req: RequestWithUser,
  ) {
    return this.projectsService.attachGithub(
      id,
      attachGitHubDto,
      req.user.id,
      req.user.roles,
    );
  }
}
