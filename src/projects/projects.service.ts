import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  BadGatewayException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubService } from '../github/github.service';
import type { GitHubProjectItem } from '../github/github.types';
import { normalizeRepositoryFullName } from '../github/repository-normalization';
import { findOrCreateGitHubUser } from '../github/github-user-resolution';
import { UsersService } from '../users/users.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { AttachGitHubDto } from './dto/attach-github.dto';
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

    // Resolve the project's organization once so we can enforce
    // org-affiliation on both PM and PL below.
    const projectDepartment = await this.prisma.department.findUnique({
      where: { id: dto.department_id },
      select: { id: true, organizationId: true },
    });
    if (!projectDepartment) {
      throw new NotFoundException('Department not found');
    }
    const projectOrganizationId = projectDepartment.organizationId;

    const projectManagerId = dto.project_manager_id ?? actorId;
    await this.assertProjectManagerAssignable(
      projectManagerId,
      actorId,
      actorRoles,
    );
    await this.assertUserBelongsToProjectOrganization(
      projectManagerId,
      projectOrganizationId,
      actorId,
      actorRoles,
    );

    if (projectManagerId === dto.project_lead_id) {
      throw new BadRequestException('Project Manager and Project Lead cannot be the same user.');
    }

    // Lookup and validate the mandatory Project Lead user
    const projectLead = await this.prisma.user.findUnique({
      where: { id: dto.project_lead_id },
      select: { id: true, githubUsername: true, name: true },
    });
    if (!projectLead) {
      throw new NotFoundException('Project Lead user not found');
    }
    await this.assertUserBelongsToProjectOrganization(
      projectLead.id,
      projectOrganizationId,
      actorId,
      actorRoles,
    );

    const evaluationWindow = this.resolveEvaluationWindow(
      dto.evaluation_window,
    );

    const repository = dto.repository?.trim() || null;
    const githubProjectId = dto.github_project_id?.trim() || null;

    // Validate collaborator access if a pre-attached repository is provided
    if (repository) {
      if (!projectLead.githubUsername) {
        throw new BadRequestException(
          `The assigned Project Lead (${projectLead.name || 'Student'}) must link their GitHub account before they can be assigned to a repository-linked project.`,
        );
      }

      const match = normalizeRepositoryFullName(repository).match(/^([^/\s]+)\/([^/\s]+)$/);
      if (!match) {
        throw new BadRequestException('Repository must use the owner/repo format, for example octocat/hello-world');
      }
      const [, owner, repoName] = match;

      const accessToken =
        githubToken ||
        (await this.usersService.getGitHubAccessToken(actorId)) ||
        this.configService.get<string>('GITHUB_PERSONAL_ACCESS_TOKEN');

      if (!accessToken) {
        throw new BadRequestException('GitHub access token is required to validate collaborator access.');
      }

      const isCollab = await this.githubService.isCollaborator(
        owner,
        repoName,
        projectLead.githubUsername,
        accessToken,
      );
      if (!isCollab) {
        throw new BadRequestException(
          `The assigned Project Lead (@${projectLead.githubUsername}) is not a collaborator on the pre-attached repository '${repository}'. Please add them as a collaborator on GitHub first.`,
        );
      }
    }

    let githubResources: { repositoryId: string } | null = null;
    if (repository && githubProjectId) {
      githubResources = await this.validateGitHubResources(
        { repository, github_project_id: githubProjectId },
        actorId,
        githubToken,
      );
      await this.assertRepositoryNotLinkedToProject(
        githubResources.repositoryId,
        actorId,
        actorRoles,
      );
    }

    try {
      const project = await this.prisma.project.create({
        data: {
          name: dto.name,
          departmentId: dto.department_id,
          repository: repository ? normalizeRepositoryFullName(repository) : null,
          githubRepositoryId: githubResources?.repositoryId ?? null,
          externalProjectId: githubProjectId,
          evalStart: evaluationWindow.evalStart,
          evalEnd: evaluationWindow.evalEnd,
          attachedByUserId: repository ? actorId : null,
          projectGithubToken: repository && githubToken ? this.encryptToken(githubToken) : null,
          createdById: actorId,
          members: {
            create: [
              {
                userId: projectManagerId,
                role: 'PROJECT_MANAGER',
                source: 'PROJECT_CREATION',
                createdBy: actorId,
              },
              {
                userId: dto.project_lead_id,
                role: 'PROJECT_LEAD',
                source: 'PROJECT_CREATION',
                createdBy: actorId,
              },
            ],
          },
        },
      });

      // Automatically sync tasks immediately after project creation if linked!
      if (repository && githubProjectId) {
        try {
          const syncToken = githubToken ||
            (await this.usersService.getGitHubAccessToken(actorId)) ||
            this.configService.get<string>('GITHUB_PERSONAL_ACCESS_TOKEN');

          if (syncToken) {
            await this.syncTasks(project.id, syncToken, actorId, actorRoles);
          }
        } catch (syncError) {
          console.error('Failed to auto-sync tasks on project creation:', syncError);
        }
      }

      // Return the complete project with updated counts
      return await this.prisma.project.findUnique({
        where: { id: project.id },
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

  /**
   * Public wrapper around the internal repository + Project V2 validation,
   * used by the "Test connection" button on the new-project form. Returns the
   * resolved GitHub repository id on success and throws a BadRequestException
   * with a human-readable message on failure.
   */
  async validateGithubCredentials(
    dto: { repository: string; github_project_id: string; github_token?: string },
    actorId: string,
  ) {
    return this.validateGitHubResources(
      { repository: dto.repository, github_project_id: dto.github_project_id },
      actorId,
      dto.github_token,
    );
  }

  private async validateGitHubResources(
    dto: { repository: string; github_project_id: string },
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

  /**
   * Defense in depth for project-creation and member-upsert flows: a user
   * assigned to a project must already be affiliated with the project's
   * organization (via any UserRole in that org/department, or any
   * ProjectMember row in a project under that org).
   *
   * The visibility check elsewhere (assertProjectMemberTargetCanBeAssigned)
   * only verifies that the actor is allowed to see the target user, which
   * for a multi-org actor includes users from other orgs they manage.
   * Without this check, an org-A manager who also manages org B could
   * silently assign an org-B-only user as PM/PL/member of an org-A project
   * — breaking the org boundary.
   *
   * Bypassed for ADMIN, and for self-assignment so an org manager not yet
   * affiliated with the org can still become its first PM.
   */
  private async assertUserBelongsToProjectOrganization(
    userId: string,
    organizationId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    if (actorRoles.includes('ADMIN')) return;
    if (userId === actorId) return;
    if (!organizationId) return;

    const affiliated = await this.prisma.user.findFirst({
      where: {
        id: userId,
        OR: [
          {
            userRoles: {
              some: {
                OR: [
                  { organizationId },
                  { department: { organizationId } },
                ],
              },
            },
          },
          {
            projectMembers: {
              some: {
                project: { department: { organizationId } },
              },
            },
          },
        ],
      },
      select: { id: true },
    });

    if (!affiliated) {
      throw new ForbiddenException(
        'Selected user is not affiliated with this project\'s organization',
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

    // Trigger background sync if active, linked, and query-er has manage privileges
    if (project.status === ProjectStatus.ACTIVE && project.externalProjectId && canManageProject) {
      this.usersService.getGitHubAccessToken(actorId)
        .then(async (userToken) => {
          const syncToken = userToken || 
            (project.projectGithubToken ? this.decryptToken(project.projectGithubToken) : null) ||
            this.configService.get<string>('GITHUB_PERSONAL_ACCESS_TOKEN');

          if (syncToken) {
            await this.syncTasks(project.id, syncToken, actorId, actorRoles);
          }
        })
        .catch((err) => {
          console.error(`Failed to background sync tasks for project ${id}:`, err);
        });
    }

    // Safely remove the encrypted projectGithubToken from the public API response
    const safeProject = { ...project };
    delete (safeProject as any).projectGithubToken;

    return safeProject;
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

    // Resolve project's organization to enforce org-affiliation on the
    // user being assigned (defense in depth: the visibility check above
    // accepts any user the actor can see, including users from other orgs
    // the actor manages but which this project does not belong to).
    const projectScope = await this.prisma.project.findUnique({
      where: { id },
      select: { department: { select: { organizationId: true } } },
    });
    if (!projectScope) {
      throw new NotFoundException('Project not found');
    }
    await this.assertUserBelongsToProjectOrganization(
      userId,
      projectScope.department.organizationId,
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

    const projectDb = await this.prisma.project.findUnique({
      where: { id },
      select: { projectGithubToken: true }
    });

    const resolvedAccessToken =
      accessToken ||
      (projectDb?.projectGithubToken ? this.decryptToken(projectDb.projectGithubToken) : null) ||
      (await this.usersService.getGitHubAccessToken(actorId)) ||
      this.configService.get<string>('GITHUB_PERSONAL_ACCESS_TOKEN');

    if (!resolvedAccessToken) {
      throw new BadRequestException(
        'Cannot sync Kanban because Lime++ has no GitHub token for this user or project. Sign out and sign in again with GitHub project permissions, or configure GITHUB_PERSONAL_ACCESS_TOKEN on the backend.',
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

  async attachGithub(
    id: string,
    dto: AttachGitHubDto,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      id,
    );

    const project = await this.prisma.project.findUnique({
      where: { id },
    });

    if (!project) throw new NotFoundException('Project not found');

    this.projectLockGuard.assertMutable(project, 'attach GitHub');

    const githubToken = dto.github_token ||
      (await this.usersService.getGitHubAccessToken(actorId)) ||
      this.configService.get<string>('GITHUB_PERSONAL_ACCESS_TOKEN');

    if (!githubToken) {
      throw new BadRequestException(
        'A GitHub Access Token is required to validate the repository and project attachment. Sign out and sign in again with GitHub, or supply a token.',
      );
    }

    const githubResources = await this.validateGitHubResources(
      { repository: dto.repository, github_project_id: dto.github_project_id },
      actorId,
      githubToken,
    );

    await this.assertRepositoryNotLinkedToProject(
      githubResources.repositoryId,
      actorId,
      actorRoles,
    );

    const updatedProject = await this.prisma.project.update({
      where: { id },
      data: {
        repository: normalizeRepositoryFullName(dto.repository),
        githubRepositoryId: githubResources.repositoryId,
        externalProjectId: dto.github_project_id,
        attachedByUserId: actorId,
        projectGithubToken: this.encryptToken(githubToken),
      },
    });

    try {
      await this.syncTasks(id, githubToken, actorId, actorRoles);
    } catch (syncError) {
      console.error('Failed to trigger initial task sync on attach:', syncError);
    }

    return this.findOne(id, actorId, actorRoles);
  }

  private encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  private decryptToken(encryptedToken: string): string | null {
    try {
      const [version, iv, tag, encrypted] = encryptedToken.split(':');
      if (version !== 'v1' || !iv || !tag || !encrypted) return null;

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getEncryptionKey(),
        Buffer.from(iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }

  private getEncryptionKey(): Buffer {
    const secret =
      this.configService.get<string>('GITHUB_TOKEN_ENCRYPTION_KEY') ||
      this.configService.get<string>('JWT_SECRET');

    if (!secret) {
      throw new Error(
        'GITHUB_TOKEN_ENCRYPTION_KEY or JWT_SECRET is required to encrypt GitHub tokens',
      );
    }

    return scryptSync(secret, 'lime-github-token', 32);
  }
}
