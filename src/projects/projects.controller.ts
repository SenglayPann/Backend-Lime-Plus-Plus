import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Create a new project (Dept Manager+)' })
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
  async findAll(
    @Query('department_id') departmentId: string | undefined,
    @Request() req: RequestWithUser,
  ) {
    return this.projectsService.findAll(
      departmentId,
      req.user.id,
      req.user.roles,
    );
  }

  @Get(':id')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'Get project details' })
  async findOne(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.projectsService.findOne(id, req.user.id, req.user.roles);
  }

  @Post(':id/lock')
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Lock project for grading (Dept Manager+)' })
  async lock(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.projectsService.lockProject(id, req.user.id, req.user.roles);
  }

  @Post(':id/tasks/sync')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Manual sync tasks from GitHub (Project Manager+)' })
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
}
