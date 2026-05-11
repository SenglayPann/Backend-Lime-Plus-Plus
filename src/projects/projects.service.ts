import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubService } from '../github/github.service';
import { UsersService } from '../users/users.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectStatus, AuditAction, TaskStatus } from '../generated/prisma';
import { ProjectAccessService } from '../common/access/project-access.service';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private githubService: GitHubService,
    private configService: ConfigService,
    private usersService: UsersService,
    private projectAccessService: ProjectAccessService,
  ) {}

  async create(
    dto: CreateProjectDto,
    actorId: string,
    actorRoles: Role[],
    githubToken?: string,
  ) {
    await this.projectAccessService.assertCanCreateProjectInDepartment(
      actorId,
      actorRoles,
      dto.department_id,
    );
    await this.validateGitHubResources(dto, actorId, githubToken);

    return this.prisma.project.create({
      data: {
        name: dto.name,
        departmentId: dto.department_id,
        repository: dto.repository,
        externalProjectId: dto.github_project_id,
        evalStart: dto.evaluation_window?.start
          ? new Date(dto.evaluation_window.start)
          : null,
        evalEnd: dto.evaluation_window?.end
          ? new Date(dto.evaluation_window.end)
          : null,
      },
    });
  }

  private async validateGitHubResources(
    dto: CreateProjectDto,
    actorId: string,
    githubToken?: string,
  ) {
    const accessToken =
      githubToken ||
      (await this.usersService.getGitHubAccessToken(actorId)) ||
      this.configService.get<string>('GITHUB_PERSONAL_ACCESS_TOKEN');

    if (!accessToken) {
      throw new BadRequestException(
        'Your GitHub login does not include a usable token for repository and Project V2 validation. Sign out and sign in again with the requested GitHub permissions, or configure GITHUB_PERSONAL_ACCESS_TOKEN on the backend.',
      );
    }

    const repository = dto.repository.trim();
    const match = repository.match(/^([^/\s]+)\/([^/\s]+)$/);

    if (!match) {
      throw new BadRequestException(
        'Repository must use the owner/repo format, for example octocat/hello-world',
      );
    }

    const [, owner, repo] = match;
    const [repoExists, projectExists] = await Promise.all([
      this.githubService.repositoryExists(owner, repo, accessToken),
      this.githubService.projectV2Exists(dto.github_project_id, accessToken),
    ]);

    if (!repoExists) {
      throw new BadRequestException(
        `GitHub repository ${repository} was not found or the token cannot access it`,
      );
    }

    if (!projectExists) {
      throw new BadRequestException(
        'GitHub Project V2 was not found or the token cannot access it',
      );
    }
  }

  async findAll(departmentId: string | undefined, actorId: string, actorRoles: Role[]) {
    return this.prisma.project.findMany({
      where: this.projectAccessService.buildAccessibleProjectWhere(
        actorId,
        actorRoles,
        departmentId,
      ),
      include: { department: true },
    });
  }

  async findOne(id: string, actorId: string, actorRoles: Role[]) {
    await this.projectAccessService.assertCanViewProject(
      actorId,
      actorRoles,
      id,
    );

    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        department: true,
        members: { include: { user: true } },
        _count: { select: { tasks: true, pullRequests: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async lockProject(id: string, actorId: string, actorRoles: Role[]) {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      id,
    );
    const project = await this.findOne(id, actorId, actorRoles);

    if (project.status === ProjectStatus.LOCKED) {
      throw new ConflictException('Project is already locked');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: {
          status: ProjectStatus.LOCKED,
          lockedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          action: AuditAction.PROJECT_LOCK,
          actorId,
          projectId: id,
          metadata: { previousStatus: project.status },
        },
      });

      return updated;
    });
  }

  async syncTasks(
    id: string,
    accessToken: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      id,
    );
    const project = await this.findOne(id, actorId, actorRoles);

    if (!project.externalProjectId) {
      throw new ConflictException('Project is not linked to a GitHub Project');
    }

    const items = await this.githubService.getProjectItems(
      project.externalProjectId,
      accessToken,
    );

    const results = await Promise.all(
      items.map(async (item) => {
        // Skip items without a title (e.g. empty rows)
        if (!item.content?.title) return null;

        // Try to find status from field values
        const statusValue = item.fieldValues.nodes.find(
          (n) => n.name === 'Status',
        )?.name;

        // Find assignee
        const assigneeLogin = item.content.assignees?.nodes[0]?.login;
        let assigneeId = null;

        if (assigneeLogin) {
          const user = await this.prisma.user.findUnique({
            where: { githubUserId: assigneeLogin }, // Assuming githubUserId is the login
          });
          assigneeId = user?.id;
        }

        // Only upsert if we have an assignee (or handle null assignee according to business rules)
        // For sync, we might just create them even without assignee and let PM assign them later

        // Map GitHub status to TaskStatus
        let taskStatus: TaskStatus = TaskStatus.TODO;
        if (statusValue === 'In Progress') taskStatus = TaskStatus.IN_PROGRESS;
        if (statusValue === 'Done') taskStatus = TaskStatus.DONE;

        return this.prisma.task.upsert({
          where: {
            projectId_externalTaskId: {
              projectId: id,
              externalTaskId: item.id,
            },
          },
          update: {
            title: item.content.title,
            status: taskStatus,
            assigneeId: assigneeId || undefined, // Don't overwrite with null if not found?
          },
          create: {
            projectId: id,
            externalTaskId: item.id,
            title: item.content.title,
            status: taskStatus,
            assigneeId: assigneeId || 'unassigned', // We might need a placeholder or allow null
          },
        });
      }),
    );

    return {
      syncedCount: results.filter((r) => r !== null).length,
    };
  }
}
