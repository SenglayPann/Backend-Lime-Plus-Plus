import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../common/access/project-access.service';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
  ) {}

  async getGlobalStats(actorId: string, actorRoles: Role[]) {
    const projectIds = await this.projectAccessService.getAccessibleProjectIds(
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
    const projectIds = await this.projectAccessService.getAccessibleProjectIds(
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
        user: true,
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
    const projectIds = await this.projectAccessService.getAccessibleProjectIds(
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
