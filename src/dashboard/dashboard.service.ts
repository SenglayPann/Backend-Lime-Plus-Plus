import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../common/access/project-access.service';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import { DepartmentAccessService } from '../common/access/department-access.service';
import { safeUserSelect } from '../common/serialization/safe-user-select';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
    private organizationAccessService: OrganizationAccessService,
    private departmentAccessService: DepartmentAccessService,
  ) {}

  async getGlobalStats(actorId: string, actorRoles: Role[]) {
    const projectIds = await this.projectAccessService.getManageableProjectIds(
      actorId,
      actorRoles,
    );

    if (projectIds.length === 0) {
      return {
        activeStudents: 0,
        ongoingProjects: 0,
        pullRequests: 0,
        avgContribution: 0,
      };
    }

    const activeStudents = await this.prisma.projectMember.groupBy({
      by: ['userId'],
      where: {
        projectId: { in: projectIds },
      },
    });

    const ongoingProjectsCount = await this.prisma.project.count({
      where: { id: { in: projectIds }, status: 'ACTIVE' },
    });

    const prsCount = await this.prisma.pullRequest.count({
      where: { projectId: { in: projectIds } },
    });

    const scores = await this.prisma.contributionScore.findMany({
      where: { projectId: { in: projectIds } },
      select: { totalScore: true },
    });

    const avgContribution =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s.totalScore, 0) / scores.length
        : 0;

    return {
      activeStudents: activeStudents.length,
      ongoingProjects: ongoingProjectsCount,
      pullRequests: prsCount,
      avgContribution: Number(avgContribution.toFixed(1)),
    };
  }

  async getRecentActivity(actorId: string, actorRoles: Role[]) {
    const projectIds = await this.projectAccessService.getManageableProjectIds(
      actorId,
      actorRoles,
    );

    if (projectIds.length === 0) {
      return [];
    }

    const recentEvents = await this.prisma.contributionEvent.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        user: { select: safeUserSelect },
        project: true,
      },
    });

    return recentEvents.map((event) => ({
      id: event.id,
      title: event.type
        .split('_')
        .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
        .join(' '),
      projectId: event.project.id,
      projectName: event.project.name,
      authorName: event.user.name || event.user.githubUsername,
      score: event.score,
      createdAt: event.createdAt,
    }));
  }

  async getTopDepartments(actorId: string, actorRoles: Role[]) {
    const projectIds = await this.projectAccessService.getManageableProjectIds(
      actorId,
      actorRoles,
    );

    if (projectIds.length === 0) {
      return [];
    }

    const depts = await this.prisma.department.findMany({
      where: {
        projects: {
          some: { id: { in: projectIds } },
        },
      },
      include: {
        projects: {
          where: { id: { in: projectIds } },
          include: {
            contributionScores: true,
          },
        },
      },
    });

    const result = depts
      .map((dept) => {
        let totalScore = 0;
        let count = 0;
        for (const proj of dept.projects) {
          for (const score of proj.contributionScores) {
            totalScore += score.totalScore;
            count++;
          }
        }
        return {
          id: dept.id,
          name: dept.name,
          avgScore: count > 0 ? Math.round(totalScore / count) : 0,
        };
      })
      .sort((a, b) => b.avgScore - a.avgScore)
      .slice(0, 4);

    return result;
  }

  async getOrganizationDashboard(
    organizationId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.organizationAccessService.assertCanManageOrganization(
      actorId,
      actorRoles,
      organizationId,
    );

    const [organization, departments, projects] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        include: {
          _count: {
            select: {
              departments: true,
              userRoles: true,
            },
          },
        },
      }),
      this.prisma.department.findMany({
        where: { organizationId },
        include: {
          userRoles: {
            where: { role: 'DEPARTMENT_MANAGER' },
            include: { user: { select: safeUserSelect } },
          },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.project.findMany({
        where: { department: { organizationId } },
        include: this.dashboardProjectInclude(),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return {
      scope: {
        type: 'organization',
        id: organization.id,
        name: organization.name,
        licensePlan: organization.licensePlan,
        createdAt: organization.createdAt,
      },
      summary: this.buildScopeSummary(projects, departments.length),
      departments: this.buildDepartmentSummaries(departments, projects),
      projects: this.buildProjectSummaries(projects),
      contributors: this.buildContributorSummaries(projects),
    };
  }

  async getDepartmentDashboard(
    departmentId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.departmentAccessService.assertCanManageDepartment(
      actorId,
      actorRoles,
      departmentId,
    );

    const [department, projects] = await Promise.all([
      this.prisma.department.findUnique({
        where: { id: departmentId },
        include: {
          organization: true,
          userRoles: {
            where: { role: 'DEPARTMENT_MANAGER' },
            include: { user: { select: safeUserSelect } },
          },
        },
      }),
      this.prisma.project.findMany({
        where: { departmentId },
        include: this.dashboardProjectInclude(),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    return {
      scope: {
        type: 'department',
        id: department.id,
        name: department.name,
        description: department.description,
        organizationId: department.organizationId,
        organizationName: department.organization.name,
        createdAt: department.createdAt,
        managers: department.userRoles.map((role) =>
          this.getUserName(role.user),
        ),
      },
      summary: this.buildScopeSummary(projects, 1),
      projects: this.buildProjectSummaries(projects),
      contributors: this.buildContributorSummaries(projects),
    };
  }

  async getMyContributions(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        githubUsername: true,
        avatarUrl: true,
        projectMembers: {
          include: {
            project: {
              include: {
                department: { include: { organization: true } },
                _count: { select: { tasks: true, pullRequests: true } },
              },
            },
          },
          orderBy: { project: { createdAt: 'desc' } },
        },
        assignedTasks: {
          include: {
            project: true,
            pullRequests: true,
          },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        },
        authoredPRs: {
          include: {
            project: true,
            task: true,
          },
          orderBy: [{ mergedAt: 'desc' }, { createdAt: 'desc' }],
          take: 20,
        },
        prReviews: {
          include: {
            pullRequest: { include: { project: true, task: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        contributionScores: {
          include: { project: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!user) {
      return null;
    }

    const scoreByProject = new Map(
      user.contributionScores.map((score) => [score.projectId, score]),
    );
    const tasksByProject = new Map<string, typeof user.assignedTasks>();
    user.assignedTasks.forEach((task) => {
      const existing = tasksByProject.get(task.projectId) || [];
      existing.push(task);
      tasksByProject.set(task.projectId, existing);
    });

    const projects = user.projectMembers.map((membership) => {
      const score = scoreByProject.get(membership.projectId);
      const tasks = tasksByProject.get(membership.projectId) || [];
      const doneTasks = tasks.filter((task) => task.status === 'DONE').length;
      const mergedPrs = user.authoredPRs.filter(
        (pr) => pr.projectId === membership.projectId && pr.status === 'MERGED',
      ).length;

      return {
        id: membership.project.id,
        name: membership.project.name,
        role: membership.role,
        status: membership.project.status,
        repository: membership.project.repository,
        department: membership.project.department.name,
        organization: membership.project.department.organization.name,
        evalStart: membership.project.evalStart,
        evalEnd: membership.project.evalEnd,
        taskCount: tasks.length,
        doneTasks,
        mergedPrs,
        totalScore: score?.totalScore || 0,
        lastScoreUpdated: score?.updatedAt || null,
      };
    });

    const assignedTasks = user.assignedTasks.map((task) => {
      const mergedPr = task.pullRequests.find((pr) => pr.status === 'MERGED');
      const linkedPr = mergedPr || task.pullRequests[0] || null;
      return {
        id: task.id,
        externalTaskId: task.externalTaskId,
        title: task.title,
        status: task.status,
        difficulty: task.difficulty,
        dueDate: task.dueDate,
        completedAt: task.completedAt,
        projectId: task.projectId,
        projectName: task.project.name,
        linkedPr: linkedPr
          ? {
              externalPrId: linkedPr.externalPrId,
              title: linkedPr.title,
              status: linkedPr.status,
              url: linkedPr.url,
              mergedAt: linkedPr.mergedAt,
            }
          : null,
        scoringStatus: this.getTaskScoringStatus(task.status, linkedPr?.status),
      };
    });

    const pullRequests = user.authoredPRs.map((pr) => ({
      id: pr.id,
      externalPrId: pr.externalPrId,
      title: pr.title,
      status: pr.status,
      url: pr.url,
      mergedAt: pr.mergedAt,
      createdAt: pr.createdAt,
      projectId: pr.projectId,
      projectName: pr.project.name,
      taskId: pr.task?.externalTaskId || null,
      taskTitle: pr.task?.title || null,
    }));

    const reviews = user.prReviews.map((review) => ({
      id: review.id,
      state: review.state,
      createdAt: review.createdAt,
      pullRequestId: review.pullRequest.externalPrId,
      pullRequestTitle: review.pullRequest.title,
      projectId: review.pullRequest.projectId,
      projectName: review.pullRequest.project.name,
      taskId: review.pullRequest.task?.externalTaskId || null,
    }));

    const totalScore = user.contributionScores.reduce(
      (sum, score) => sum + score.totalScore,
      0,
    );
    const doneTasks = assignedTasks.filter(
      (task) => task.status === 'DONE',
    ).length;
    const mergedPrs = pullRequests.filter(
      (pr) => pr.status === 'MERGED',
    ).length;
    const approvedReviews = reviews.filter(
      (review) => review.state === 'APPROVED',
    ).length;
    const warnings = this.getContributorWarnings(assignedTasks, pullRequests);

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        githubUsername: user.githubUsername,
        avatarUrl: user.avatarUrl,
      },
      summary: {
        activeProjects: projects.filter(
          (project) => project.status === 'ACTIVE',
        ).length,
        assignedTasks: assignedTasks.length,
        doneTasks,
        mergedPrs,
        approvedReviews,
        totalScore,
      },
      projects,
      assignedTasks,
      pullRequests,
      reviews,
      scores: user.contributionScores.map((score) => ({
        projectId: score.projectId,
        projectName: score.project.name,
        totalScore: score.totalScore,
        breakdown: score.breakdown,
        updatedAt: score.updatedAt,
      })),
      warnings,
    };
  }

  private getTaskScoringStatus(taskStatus: string, prStatus?: string) {
    if (prStatus === 'MERGED') return 'Scored from merged PR evidence';
    if (taskStatus === 'DONE') {
      return 'Done on Kanban, but no merged PR evidence yet';
    }
    if (prStatus === 'OPEN') return 'PR is open; score waits for merge';
    return 'No linked PR evidence yet';
  }

  private dashboardProjectInclude() {
    return {
      department: { include: { organization: true } },
      members: { include: { user: { select: safeUserSelect } } },
      tasks: { include: { assignee: { select: safeUserSelect } } },
      pullRequests: {
        include: { author: { select: safeUserSelect }, reviews: true },
      },
      contributionScores: { include: { user: { select: safeUserSelect } } },
      scoreOverrides: true,
    } as const;
  }

  private buildScopeSummary(
    projects: DashboardProject[],
    departmentCount: number,
  ) {
    const memberIds = new Set<string>();
    const activeContributorIds = new Set<string>();
    let taskCount = 0;
    let doneTasks = 0;
    let pullRequestCount = 0;
    let mergedPrs = 0;
    let totalScore = 0;
    let scoreCount = 0;

    projects.forEach((project) => {
      project.members.forEach((member) => memberIds.add(member.userId));
      taskCount += project.tasks.length;
      doneTasks += project.tasks.filter((task) => task.status === 'DONE')
        .length;
      pullRequestCount += project.pullRequests.length;
      mergedPrs += project.pullRequests.filter((pr) => pr.status === 'MERGED')
        .length;

      project.contributionScores.forEach((score) => {
        totalScore += score.totalScore;
        scoreCount += 1;
        if (score.totalScore > 0) activeContributorIds.add(score.userId);
      });

      project.tasks.forEach((task) => {
        if (task.status === 'DONE') activeContributorIds.add(task.assigneeId);
      });
      project.pullRequests.forEach((pr) => {
        if (pr.status === 'MERGED') activeContributorIds.add(pr.authorId);
      });
    });

    return {
      departments: departmentCount,
      projects: projects.length,
      activeProjects: projects.filter((project) => project.status === 'ACTIVE')
        .length,
      lockedProjects: projects.filter((project) => project.status === 'LOCKED')
        .length,
      members: memberIds.size,
      activeContributors: activeContributorIds.size,
      tasks: taskCount,
      doneTasks,
      pullRequests: pullRequestCount,
      mergedPrs,
      avgScore: scoreCount > 0 ? Number((totalScore / scoreCount).toFixed(1)) : 0,
      avgDoneTasks:
        memberIds.size > 0 ? Number((doneTasks / memberIds.size).toFixed(2)) : 0,
    };
  }

  private buildDepartmentSummaries(
    departments: DashboardDepartment[],
    projects: DashboardProject[],
  ) {
    return departments.map((department) => {
      const departmentProjects = projects.filter(
        (project) => project.departmentId === department.id,
      );
      const summary = this.buildScopeSummary(departmentProjects, 1);

      return {
        id: department.id,
        name: department.name,
        managerNames: department.userRoles.map((role) =>
          this.getUserName(role.user),
        ),
        projects: summary.projects,
        activeProjects: summary.activeProjects,
        members: summary.members,
        doneTasks: summary.doneTasks,
        mergedPrs: summary.mergedPrs,
        avgScore: summary.avgScore,
      };
    });
  }

  private buildProjectSummaries(projects: DashboardProject[]) {
    return projects.map((project) => {
      const scoreCount = project.contributionScores.length;
      const totalScore = project.contributionScores.reduce(
        (total, score) => total + score.totalScore,
        0,
      );

      return {
        id: project.id,
        name: project.name,
        status: project.status,
        repository: project.repository,
        departmentId: project.departmentId,
        departmentName: project.department.name,
        organizationId: project.department.organizationId,
        organizationName: project.department.organization.name,
        members: project.members.length,
        tasks: project.tasks.length,
        doneTasks: project.tasks.filter((task) => task.status === 'DONE')
          .length,
        pullRequests: project.pullRequests.length,
        mergedPrs: project.pullRequests.filter((pr) => pr.status === 'MERGED')
          .length,
        avgScore:
          scoreCount > 0 ? Number((totalScore / scoreCount).toFixed(1)) : 0,
        createdAt: project.createdAt,
      };
    });
  }

  private buildContributorSummaries(projects: DashboardProject[]) {
    const contributors = new Map<
      string,
      {
        userId: string;
        name: string;
        githubUsername: string;
        projectCount: number;
        totalScore: number;
        doneTasks: number;
        mergedPrs: number;
        approvedReviews: number;
      }
    >();

    const ensureContributor = (
      userId: string,
      user: { name: string | null; githubUsername: string | null },
    ) => {
      const current = contributors.get(userId);
      if (current) return current;

      const created = {
        userId,
        name: this.getUserName(user),
        githubUsername: user.githubUsername || '',
        projectCount: 0,
        totalScore: 0,
        doneTasks: 0,
        mergedPrs: 0,
        approvedReviews: 0,
      };
      contributors.set(userId, created);
      return created;
    };

    projects.forEach((project) => {
      const projectContributorIds = new Set<string>();

      project.members.forEach((member) => {
        const contributor = ensureContributor(member.userId, member.user);
        projectContributorIds.add(contributor.userId);
      });

      project.contributionScores.forEach((score) => {
        const contributor = ensureContributor(score.userId, score.user);
        contributor.totalScore += score.totalScore;
        projectContributorIds.add(contributor.userId);
      });

      project.tasks.forEach((task) => {
        if (task.status !== 'DONE') return;
        const contributor = ensureContributor(task.assigneeId, task.assignee);
        contributor.doneTasks += 1;
        projectContributorIds.add(contributor.userId);
      });

      project.pullRequests.forEach((pr) => {
        const author = ensureContributor(pr.authorId, pr.author);
        projectContributorIds.add(author.userId);
        if (pr.status === 'MERGED') author.mergedPrs += 1;

        pr.reviews.forEach((review) => {
          if (review.state !== 'APPROVED') return;
          const reviewerMember = project.members.find(
            (member) => member.userId === review.reviewerId,
          );
          if (!reviewerMember) return;
          const reviewer = ensureContributor(
            reviewerMember.userId,
            reviewerMember.user,
          );
          reviewer.approvedReviews += 1;
          projectContributorIds.add(reviewer.userId);
        });
      });

      projectContributorIds.forEach((userId) => {
        const contributor = contributors.get(userId);
        if (contributor) contributor.projectCount += 1;
      });
    });

    return Array.from(contributors.values())
      .sort(
        (a, b) =>
          b.totalScore - a.totalScore ||
          b.doneTasks - a.doneTasks ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 12);
  }

  private getUserName(user: {
    name: string | null;
    githubUsername: string | null;
  }) {
    return user.name || user.githubUsername || 'Unknown user';
  }

  private getContributorWarnings(
    assignedTasks: Array<{
      externalTaskId: string;
      status: string;
      linkedPr: { status: string } | null;
    }>,
    pullRequests: Array<{ taskId: string | null; status: string }>,
  ) {
    const warnings: string[] = [];
    const doneWithoutMergedPr = assignedTasks.filter(
      (task) => task.status === 'DONE' && task.linkedPr?.status !== 'MERGED',
    ).length;
    const openPrs = pullRequests.filter((pr) => pr.status === 'OPEN').length;
    const unlinkedPrs = pullRequests.filter((pr) => !pr.taskId).length;

    if (doneWithoutMergedPr > 0) {
      warnings.push(
        `${doneWithoutMergedPr} Done task(s) have no merged PR evidence yet.`,
      );
    }
    if (openPrs > 0) {
      warnings.push(`${openPrs} pull request(s) are still open.`);
    }
    if (unlinkedPrs > 0) {
      warnings.push(`${unlinkedPrs} pull request(s) are not linked to a task.`);
    }

    return warnings;
  }
}

type DashboardUser = {
  name: string | null;
  githubUsername: string | null;
};

type DashboardProject = {
  id: string;
  name: string;
  status: string;
  repository: string;
  departmentId: string;
  createdAt: Date;
  department: {
    id?: string;
    name: string;
    organizationId: string;
    organization: { name: string };
  };
  members: Array<{
    userId: string;
    user: DashboardUser;
  }>;
  tasks: Array<{
    assigneeId: string;
    status: string;
    assignee: DashboardUser;
  }>;
  pullRequests: Array<{
    authorId: string;
    status: string;
    author: DashboardUser;
    reviews: Array<{
      reviewerId: string;
      state: string;
    }>;
  }>;
  contributionScores: Array<{
    userId: string;
    totalScore: number;
    user: DashboardUser;
  }>;
  scoreOverrides: Array<unknown>;
};

type DashboardDepartment = {
  id: string;
  name: string;
  userRoles: Array<{
    user: DashboardUser;
  }>;
};
