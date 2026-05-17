import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  BadGatewayException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubService } from '../github/github.service';
import type { GitHubProjectItem } from '../github/github.types';
import { normalizeRepositoryFullName } from '../github/repository-normalization';
import { findOrCreateGitHubUser } from '../github/github-user-resolution';
import { UsersService } from '../users/users.service';
import { CreateProjectDto } from './dto/create-project.dto';
import {
  ProjectStatus,
  AuditAction,
  TaskStatus,
  Role as PrismaRole,
  Prisma,
} from '../generated/prisma';
import { ProjectAccessService } from '../common/access/project-access.service';
import { ProjectLockGuardService } from '../common/access/project-lock-guard.service';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import { UserVisibilityService } from '../common/access/user-visibility.service';
import { safeUserSelect } from '../common/serialization/safe-user-select';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private githubService: GitHubService,
    private configService: ConfigService,
    private usersService: UsersService,
    private projectAccessService: ProjectAccessService,
    private projectLockGuard: ProjectLockGuardService,
    private roleDelegationService: RoleDelegationService,
    private userVisibilityService: UserVisibilityService,
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
    const githubResources = await this.validateGitHubResources(
      dto,
      actorId,
      githubToken,
    );
    await this.assertRepositoryNotLinkedToProject(
      githubResources.repositoryId,
      actorId,
      actorRoles,
    );
    const projectManagerId = dto.project_manager_id ?? actorId;
    await this.assertProjectManagerAssignable(
      projectManagerId,
      actorId,
      actorRoles,
    );

    const evaluationWindow = this.resolveEvaluationWindow(
      dto.evaluation_window,
    );

    try {
      return await this.prisma.project.create({
        data: {
          name: dto.name,
          departmentId: dto.department_id,
          repository: normalizeRepositoryFullName(dto.repository),
          githubRepositoryId: githubResources.repositoryId,
          externalProjectId: dto.github_project_id,
          evalStart: evaluationWindow.evalStart,
          evalEnd: evaluationWindow.evalEnd,
          members: {
            create: {
              userId: projectManagerId,
              role: 'PROJECT_MANAGER',
              source: 'PROJECT_CREATION',
              createdBy: actorId,
            },
          },
        },
        include: {
          department: true,
          members: { include: { user: { select: safeUserSelect } } },
          _count: {
            select: { members: true, tasks: true, pullRequests: true },
          },
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error, 'githubRepositoryId')) {
        throw new ConflictException(
          'A project already exists for this GitHub repository',
        );
      }

      throw error;
    }
  }

  private async assertRepositoryNotLinkedToProject(
    repositoryId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    const existingProject = await this.prisma.project.findUnique({
      where: { githubRepositoryId: repositoryId },
      select: { id: true, name: true },
    });

    if (!existingProject) {
      return;
    }

    const visibleExistingProject = await this.prisma.project.findFirst({
      where: {
        AND: [
          { id: existingProject.id },
          this.projectAccessService.buildAccessibleProjectWhere(
            actorId,
            actorRoles,
          ),
        ],
      },
      select: { id: true },
    });

    if (!visibleExistingProject) {
      throw new ConflictException(
        'A project already exists for this GitHub repository',
      );
    }

    throw new ConflictException(
      `A project already exists for this GitHub repository: ${existingProject.name}`,
    );
  }

  private isUniqueConstraintError(error: unknown, field: string) {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { code?: unknown; meta?: { target?: unknown } };
    if (candidate.code !== 'P2002') {
      return false;
    }

    const target = candidate.meta?.target;
    if (Array.isArray(target)) {
      return target.includes(field);
    }

    return target === field;
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

    const repository = normalizeRepositoryFullName(dto.repository);
    const match = repository.match(/^([^/\s]+)\/([^/\s]+)$/);

    if (!match) {
      throw new BadRequestException(
        'Repository must use the owner/repo format, for example octocat/hello-world',
      );
    }

    const [, owner, repo] = match;
    const [repositoryInfo, projectExists] = await Promise.all([
      this.githubService.getRepositoryInfo(owner, repo, accessToken),
      this.githubService.projectV2Exists(dto.github_project_id, accessToken),
    ]);

    if (!repositoryInfo) {
      throw new BadRequestException(
        `GitHub repository ${repository} was not found or the token cannot access it`,
      );
    }

    if (!projectExists) {
      throw new BadRequestException(
        'GitHub Project V2 was not found or the token cannot access it',
      );
    }

    return { repositoryId: repositoryInfo.id };
  }

  private resolveEvaluationWindow(
    evaluationWindow: CreateProjectDto['evaluation_window'],
  ) {
    const evalStart = evaluationWindow?.start
      ? new Date(evaluationWindow.start)
      : null;
    const evalEnd = evaluationWindow?.end ? new Date(evaluationWindow.end) : null;

    if (evalStart && Number.isNaN(evalStart.getTime())) {
      throw new BadRequestException('Evaluation window start must be a date');
    }

    if (evalEnd && Number.isNaN(evalEnd.getTime())) {
      throw new BadRequestException('Evaluation window end must be a date');
    }

    if (evalStart && evalEnd && evalStart > evalEnd) {
      throw new BadRequestException(
        'Evaluation window start must be before or equal to end',
      );
    }

    return { evalStart, evalEnd };
  }

  private async assertProjectManagerAssignable(
    userId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new BadRequestException('Selected project manager does not exist');
    }

    if (userId === actorId || actorRoles.includes('ADMIN')) {
      return;
    }

    await this.roleDelegationService.assertTargetCanBeManaged(
      actorId,
      actorRoles,
      userId,
    );

    const visibleUser = await this.prisma.user.findFirst({
      where: {
        AND: [
          { id: userId },
          this.userVisibilityService.buildVisibleUserWhere(actorId, actorRoles),
        ],
      },
      select: { id: true },
    });

    if (!visibleUser) {
      throw new ForbiddenException(
        'Selected project manager is outside your manageable scope',
      );
    }
  }

  async findAll(
    departmentId: string | undefined,
    actorId: string,
    actorRoles: Role[],
    search?: string,
  ) {
    const accessibleWhere = this.projectAccessService.buildAccessibleProjectWhere(
      actorId,
      actorRoles,
      departmentId,
    );
    const searchWhere = this.buildProjectSearchWhere(search);

    return this.prisma.project.findMany({
      where: searchWhere
        ? { AND: [accessibleWhere, searchWhere] }
        : accessibleWhere,
      include: {
        department: { include: { organization: true } },
        _count: { select: { members: true } },
      },
    });
  }

  private buildProjectSearchWhere(
    search?: string,
  ): Prisma.ProjectWhereInput | undefined {
    const term = search?.trim();
    if (!term) return undefined;

    const contains = { contains: term, mode: Prisma.QueryMode.insensitive };
    const normalized = term.toLowerCase();
    const matchingStatuses = Object.values(ProjectStatus).filter((status) =>
      status.toLowerCase().includes(normalized),
    );
    const clauses: Prisma.ProjectWhereInput[] = [
      { name: contains },
      { repository: contains },
      { externalProjectId: contains },
      { githubRepositoryId: contains },
      {
        department: {
          OR: [
            { name: contains },
            { organization: { name: contains } },
          ],
        },
      },
    ];

    if (matchingStatuses.length > 0) {
      clauses.push({ status: { in: matchingStatuses } });
    }

    return { OR: clauses };
  }

  async findOne(id: string, actorId: string, actorRoles: Role[]) {
    await this.projectAccessService.assertCanViewProject(
      actorId,
      actorRoles,
      id,
    );

    const canManageProject = await this.projectAccessService.canManageProject(
      actorId,
      actorRoles,
      id,
    );

    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        department: true,
        members: { include: { user: { select: safeUserSelect } } },
        _count: {
          select: {
            members: true,
            tasks: canManageProject
              ? true
              : {
                  where: { assigneeId: actorId },
                },
            pullRequests: canManageProject
              ? true
              : {
                  where: { authorId: actorId },
                },
          },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async listMembers(id: string, actorId: string, actorRoles: Role[]) {
    await this.projectAccessService.assertCanViewProject(
      actorId,
      actorRoles,
      id,
    );

    return this.prisma.projectMember.findMany({
      where: { projectId: id },
      include: { user: { select: safeUserSelect } },
      orderBy: [{ role: 'desc' }, { user: { name: 'asc' } }],
    });
  }

  async upsertMember(
    id: string,
    userId: string,
    role: PrismaRole,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      id,
    );
    this.assertProjectMembershipRole(role);
    await this.assertProjectMemberTargetCanBeAssigned(
      id,
      userId,
      actorId,
      actorRoles,
    );

    if (role === PrismaRole.PROJECT_MANAGER) {
      await this.assertCanAssignProjectManager(id, actorId, actorRoles);
    }

    const existing = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId } },
    });

    if (
      existing?.role === PrismaRole.PROJECT_MANAGER &&
      role !== existing.role
    ) {
      await this.assertCanAssignProjectManager(id, actorId, actorRoles);
      await this.assertProjectKeepsAnotherManager(id, existing.id);
    }

    const member = await this.prisma.projectMember.upsert({
      where: {
        projectId_userId: {
          projectId: id,
          userId,
        },
      },
      update: {
        role,
        source: 'MANUAL',
      },
      create: {
        projectId: id,
        userId,
        role,
        source: 'MANUAL',
        createdBy: actorId,
      },
      include: { user: { select: safeUserSelect } },
    });

    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.ROLE_CHANGE,
        actorId,
        projectId: id,
        metadata: {
          operation: existing ? 'update_project_member' : 'add_project_member',
          targetUserId: userId,
          previousRole: existing?.role || null,
          role,
        },
      },
    });

    return member;
  }

  async removeMember(
    id: string,
    memberId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      id,
    );

    const member = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId: id },
    });

    if (!member) {
      throw new NotFoundException('Project member not found');
    }

    if (member.role === PrismaRole.PROJECT_MANAGER) {
      await this.assertCanAssignProjectManager(id, actorId, actorRoles);
      await this.assertProjectKeepsAnotherManager(id, member.id);
    }

    await this.assertMemberHasNoProjectEvidence(id, member.userId);

    const removed = await this.prisma.projectMember.delete({
      where: { id: member.id },
    });

    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.ROLE_CHANGE,
        actorId,
        projectId: id,
        metadata: {
          operation: 'remove_project_member',
          targetUserId: member.userId,
          role: member.role,
        },
      },
    });

    return removed;
  }

  async lockProject(id: string, actorId: string, actorRoles: Role[]) {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      id,
    );
    await this.assertCanPerformProjectGovernanceAction(id, actorId, actorRoles);
    const project = await this.findOne(id, actorId, actorRoles);

    if (project.status === ProjectStatus.LOCKED) {
      throw new ConflictException('Project is already locked');
    }

    await this.assertProjectCanLock(id);

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

    this.projectLockGuard.assertMutable(project, 'sync tasks');

    const resolvedAccessToken =
      accessToken ||
      (await this.usersService.getGitHubAccessToken(actorId)) ||
      this.configService.get<string>('GITHUB_PERSONAL_ACCESS_TOKEN');

    if (!resolvedAccessToken) {
      throw new BadRequestException(
        'Cannot sync Kanban because Lime++ has no GitHub token for this user. Sign out and sign in again with GitHub project permissions, or configure GITHUB_PERSONAL_ACCESS_TOKEN on the backend.',
      );
    }

    let items: GitHubProjectItem[];
    try {
      items = await this.githubService.getProjectItems(
        project.externalProjectId,
        resolvedAccessToken,
      );
    } catch {
      throw new BadGatewayException(
        'GitHub Project V2 sync failed. Check that the token can access this repository and Project V2 board with read:project permissions.',
      );
    }

    const summary = {
      totalItemsSeen: items.length,
      tasksCreated: 0,
      tasksUpdated: 0,
      skippedDrafts: 0,
      skippedUnassigned: 0,
      unassignedTasks: 0,
      membersAutoAdded: 0,
      warnings: [] as string[],
    };

    await Promise.all(
      items.map(async (item) => {
        // Skip items without a title (e.g. empty rows)
        if (!item.content?.title) {
          summary.skippedDrafts += 1;
          summary.warnings.push(`Skipped draft item ${item.id}: no title`);
          return null;
        }

        const externalTaskId = this.getTaskCode(item);

        const statusValue = item.fieldValues.nodes.find(
          (n) => n.field?.name === 'Status',
        )?.name;

        const assignee = await this.resolveProjectItemAssignee(item);
        const assigneeId = assignee?.id ?? null;
        if (!assigneeId) {
          summary.unassignedTasks += 1;
          summary.warnings.push(
            `Imported ${externalTaskId} without an assignee`,
          );
        }

        if (assigneeId) {
          const memberAdded = await this.ensureProjectMembership(id, assigneeId);
          if (memberAdded) summary.membersAutoAdded += 1;
        }

        // Map GitHub status to TaskStatus
        let taskStatus: TaskStatus = TaskStatus.TODO;
        if (statusValue === 'In Progress') taskStatus = TaskStatus.IN_PROGRESS;
        if (statusValue === 'Done') taskStatus = TaskStatus.DONE;

        const existingTask = await this.prisma.task.findUnique({
          where: {
            projectId_externalTaskId: {
              projectId: id,
              externalTaskId,
            },
          },
          select: { id: true, assigneeId: true, status: true },
        });

        await this.prisma.task.upsert({
          where: {
            projectId_externalTaskId: {
              projectId: id,
              externalTaskId,
            },
          },
          update: {
            title: item.content.title,
            status: taskStatus,
            assigneeId,
          },
          create: {
            projectId: id,
            externalTaskId,
            title: item.content.title,
            status: taskStatus,
            assigneeId,
          },
        });

        if (existingTask) {
          summary.tasksUpdated += 1;
          const auditWrites: Array<Promise<unknown>> = [];

          if (existingTask.status !== taskStatus) {
            auditWrites.push(
              this.prisma.auditLog.create({
                data: {
                  action: AuditAction.TASK_REASSIGN,
                  actorId,
                  projectId: id,
                  metadata: {
                    type: 'TASK_STATUS_CHANGE',
                    taskId: externalTaskId,
                    previousStatus: existingTask.status,
                    newStatus: taskStatus,
                    source: 'KANBAN_SYNC',
                  },
                },
              }),
            );
          }

          if (existingTask.assigneeId !== assigneeId) {
            auditWrites.push(
              this.prisma.auditLog.create({
                data: {
                  action: AuditAction.TASK_REASSIGN,
                  actorId,
                  projectId: id,
                  metadata: {
                    type: 'TASK_ASSIGNEE_CHANGE',
                    taskId: externalTaskId,
                    previousAssigneeId: existingTask.assigneeId,
                    newAssigneeId: assigneeId,
                    source: 'KANBAN_SYNC',
                  },
                },
              }),
            );
          }

          await Promise.all(auditWrites);
        } else {
          summary.tasksCreated += 1;
        }

        return null;
      }),
    );

    return {
      ...summary,
      syncedCount: summary.tasksCreated + summary.tasksUpdated,
    };
  }

  private getTaskCode(item: GitHubProjectItem): string {
    const explicitCode = item.fieldValues.nodes
      .map((node) => node.text?.trim())
      .find((text): text is string =>
        Boolean(text?.match(/^TASK-[A-Za-z0-9_-]+$/i)),
      );

    if (explicitCode) return explicitCode.toUpperCase();
    if (item.content.number) return `TASK-${item.content.number}`;
    return `TASK-${item.id}`;
  }

  private async resolveProjectItemAssignee(item: GitHubProjectItem) {
    const assignee = item.content.assignees?.nodes[0];
    if (!assignee) return null;

    const githubUserId =
      assignee.databaseId !== null && assignee.databaseId !== undefined
        ? String(assignee.databaseId)
        : assignee.id;

    if (!githubUserId) return null;

    return findOrCreateGitHubUser(this.prisma, {
      githubUserId,
      login: assignee.login,
      avatarUrl: assignee.avatarUrl,
    });
  }

  private async ensureProjectMembership(
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const existing = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      select: { id: true },
    });

    await this.prisma.projectMember.upsert({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      update: {},
      create: {
        projectId,
        userId,
        source: 'KANBAN_SYNC',
      },
    });

    return !existing;
  }

  private assertProjectMembershipRole(role: PrismaRole) {
    if (
      role !== PrismaRole.PROJECT_MANAGER &&
      role !== PrismaRole.PROJECT_MEMBER
    ) {
      throw new BadRequestException(
        'Project membership role must be PROJECT_MANAGER or PROJECT_MEMBER',
      );
    }
  }

  private async assertProjectMemberUserExists(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new BadRequestException('Selected user does not exist');
    }
  }

  private async assertProjectMemberTargetCanBeAssigned(
    projectId: string,
    userId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.assertProjectMemberUserExists(userId);

    if (!actorRoles.includes('ADMIN') && userId !== actorId) {
      await this.roleDelegationService.assertTargetCanBeManaged(
        actorId,
        actorRoles,
        userId,
      );
    }

    if (actorRoles.includes('ADMIN')) {
      return;
    }

    const visibleUser = await this.prisma.user.findFirst({
      where: {
        AND: [
          { id: userId },
          this.userVisibilityService.buildVisibleUserWhere(
            actorId,
            actorRoles,
          ),
        ],
      },
      select: { id: true },
    });

    if (!visibleUser) {
      throw new ForbiddenException(
        'Selected user is outside your visible scope',
      );
    }

    const manageableWhere = this.projectAccessService.buildManageableProjectWhere(
      actorId,
      actorRoles,
    );

    if (!manageableWhere) {
      throw new ForbiddenException(
        'You do not have permission to manage this project member',
      );
    }

    const manageableProject = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ...manageableWhere,
      },
      select: { id: true },
    });

    if (!manageableProject) {
      throw new ForbiddenException(
        'You do not have permission to manage this project member',
      );
    }
  }

  private async assertCanAssignProjectManager(
    projectId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    if (actorRoles.includes('ADMIN')) return;

    const managementClauses: Prisma.ProjectWhereInput[] = [];

    if (actorRoles.includes('ORGANIZATION_MANAGER')) {
      managementClauses.push({
        department: {
          organization: {
            userRoles: {
              some: {
                userId: actorId,
                role: PrismaRole.ORGANIZATION_MANAGER,
              },
            },
          },
        },
      });
    }

    if (actorRoles.includes('DEPARTMENT_MANAGER')) {
      managementClauses.push({
        department: {
          userRoles: {
            some: {
              userId: actorId,
              role: PrismaRole.DEPARTMENT_MANAGER,
            },
          },
        },
      });
    }

    if (managementClauses.length === 0) {
      throw new ForbiddenException(
        'Only department managers or higher can assign project managers',
      );
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        OR: managementClauses,
      },
      select: { id: true },
    });

    if (!project) {
      throw new ForbiddenException(
        'You do not have permission to assign a project manager here',
      );
    }
  }

  private async assertCanPerformProjectGovernanceAction(
    projectId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.assertCanAssignProjectManager(projectId, actorId, actorRoles);
  }

  private async assertProjectKeepsAnotherManager(
    projectId: string,
    excludedMemberId: string,
  ) {
    const managerCount = await this.prisma.projectMember.count({
      where: {
        projectId,
        role: PrismaRole.PROJECT_MANAGER,
        id: { not: excludedMemberId },
      },
    });

    if (managerCount === 0) {
      throw new ConflictException(
        'Project must keep at least one project manager',
      );
    }
  }

  private async assertMemberHasNoProjectEvidence(
    projectId: string,
    userId: string,
  ) {
    const [
      assignedTasks,
      authoredPullRequests,
      submittedReviews,
      contributionScores,
      scoreOverrides,
      contributionEvents,
    ] = await Promise.all([
      this.prisma.task.count({ where: { projectId, assigneeId: userId } }),
      this.prisma.pullRequest.count({
        where: { projectId, authorId: userId },
      }),
      this.prisma.prReview.count({
        where: { reviewerId: userId, pullRequest: { projectId } },
      }),
      this.prisma.contributionScore.count({ where: { projectId, userId } }),
      this.prisma.scoreOverride.count({ where: { projectId, userId } }),
      this.prisma.contributionEvent.count({ where: { projectId, userId } }),
    ]);

    const blockers = [
      { label: 'assigned tasks', count: assignedTasks },
      { label: 'authored pull requests', count: authoredPullRequests },
      { label: 'submitted reviews', count: submittedReviews },
      { label: 'contribution scores', count: contributionScores },
      { label: 'score overrides', count: scoreOverrides },
      { label: 'contribution events', count: contributionEvents },
    ]
      .filter((blocker) => blocker.count > 0)
      .map((blocker) => `${blocker.count} ${blocker.label}`);

    if (blockers.length > 0) {
      throw new ConflictException(
        `Cannot remove project member with existing project evidence: ${blockers.join(', ')}`,
      );
    }
  }

  private async assertProjectCanLock(projectId: string) {
    const [projectManager, assignedTaskCount] = await Promise.all([
      this.prisma.projectMember.findFirst({
        where: {
          projectId,
          role: 'PROJECT_MANAGER',
        },
        select: { id: true },
      }),
      this.prisma.task.count({
        where: {
          projectId,
          assigneeId: { not: null },
        },
      }),
    ]);

    if (!projectManager) {
      throw new ConflictException(
        'Project must have at least one project manager before it can be locked',
      );
    }

    if (assignedTaskCount === 0) {
      throw new ConflictException(
        'Project must have at least one assigned task before it can be locked',
      );
    }
  }
}
