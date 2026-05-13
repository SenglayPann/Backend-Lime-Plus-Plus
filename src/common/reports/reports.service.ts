import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from './pdf.service';
import { Parser } from 'json2csv';
import { ProjectStatus } from '../../generated/prisma';
import { ScoreBreakdown } from '../../scoring/scoring.service';
import { ProjectAccessService } from '../access/project-access.service';
import { OrganizationAccessService } from '../access/organization-access.service';
import { DepartmentAccessService } from '../access/department-access.service';
import type { Role } from '../decorators/roles.decorator';

type ScoreSummary = {
  taskCompletionPoints: number;
  reviewPoints: number;
  overrideDelta: number;
};

type ProjectMemberSummary = {
  userId: string;
  name: string;
  githubUsername: string;
  email: string;
  projectRole: string;
  totalScore: number;
  doneTasks: number;
  mergedPrs: number;
  approvedReviews: number;
  overrideDelta: number;
  lastScoreUpdated: Date | null;
};

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private pdfService: PdfService,
    private projectAccessService: ProjectAccessService,
    private organizationAccessService: OrganizationAccessService,
    private departmentAccessService: DepartmentAccessService,
  ) {}

  async exportIndividualPdf(
    projectId: string,
    userId: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<Buffer> {
    await this.projectAccessService.assertCanViewProject(
      actorId,
      actorRoles,
      projectId,
    );

    if (actorId !== userId) {
      await this.projectAccessService.assertCanManageProject(
        actorId,
        actorRoles,
        projectId,
      );
    }

    const scoreInfo = await this.prisma.contributionScore.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: {
        user: true,
        project: {
          include: {
            department: {
              include: { organization: true },
            },
            members: {
              where: { userId },
            },
          },
        },
      },
    });

    if (!scoreInfo) throw new NotFoundException('Score data not found');

    const [pullRequests, reviews, assignedTasks, overrides] = await Promise.all(
      [
        this.prisma.pullRequest.findMany({
          where: { projectId, authorId: userId },
          include: { task: true },
          orderBy: [{ mergedAt: 'asc' }, { createdAt: 'asc' }],
        }),
        this.prisma.prReview.findMany({
          where: { reviewerId: userId, pullRequest: { projectId } },
          include: { pullRequest: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.task.findMany({
          where: { projectId, assigneeId: userId },
          include: { pullRequests: true },
          orderBy: { externalTaskId: 'asc' },
        }),
        this.prisma.scoreOverride.findMany({
          where: { projectId, userId },
          include: { overrider: true },
          orderBy: { createdAt: 'asc' },
        }),
      ],
    );

    const breakdownData = scoreInfo.breakdown as unknown as ScoreBreakdown;
    const scoreSummary = this.getScoreSummary(breakdownData);
    const mergedPrs = pullRequests.filter((pr) => pr.status === 'MERGED');
    const warnings = this.getIndividualWarnings(pullRequests, assignedTasks);

    const reportData = {
      student: {
        name:
          scoreInfo.user.name ||
          scoreInfo.user.githubUsername ||
          'Unknown user',
        githubUsername: scoreInfo.user.githubUsername || 'N/A',
        email: scoreInfo.user.email || 'N/A',
        projectRole: scoreInfo.project.members[0]?.role || 'PROJECT_MEMBER',
      },
      project: {
        name: scoreInfo.project.name,
        organization: scoreInfo.project.department.organization.name,
        department: scoreInfo.project.department.name,
        repository: scoreInfo.project.repository,
        externalProjectId: scoreInfo.project.externalProjectId || 'N/A',
        status: scoreInfo.project.status,
        evalStart: scoreInfo.project.evalStart,
        evalEnd: scoreInfo.project.evalEnd,
        lockedAt: scoreInfo.project.lockedAt,
        generatedAt: new Date(),
      },
      score: {
        totalScore: scoreInfo.totalScore,
        taskCompletionPoints: scoreSummary.taskCompletionPoints,
        reviewPoints: scoreSummary.reviewPoints,
        overrideDelta: scoreSummary.overrideDelta,
        lastUpdated: scoreInfo.updatedAt,
      },
      contributionEvidence: mergedPrs.map((pr) => ({
        taskId: pr.task?.externalTaskId || 'Unlinked',
        title: pr.task?.title || 'Unknown Task',
        prNumber: pr.externalPrId,
        prTitle: pr.title,
        status: pr.status,
        mergedAt: pr.mergedAt,
        score: this.findTaskScore(breakdownData, pr.task?.externalTaskId),
        url:
          pr.url ||
          `https://github.com/${scoreInfo.project.repository}/pull/${pr.externalPrId}`,
      })),
      reviews: reviews.map((review) => ({
        prNumber: review.pullRequest.externalPrId,
        state: review.state,
        createdAt: review.createdAt,
      })),
      overrides: overrides.map((override) => ({
        delta: override.delta,
        reason: override.reason,
        overriddenBy:
          override.overrider.name ||
          override.overrider.githubUsername ||
          'Unknown user',
        createdAt: override.createdAt,
      })),
      warnings,
    };

    return this.pdfService.generateIndividualReport(reportData);
  }

  async exportProjectPdf(
    projectId: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<Buffer> {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      projectId,
    );

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        department: { include: { organization: true } },
        members: { include: { user: true } },
        tasks: {
          include: {
            assignee: true,
            pullRequests: {
              include: { author: true },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { externalTaskId: 'asc' },
        },
        pullRequests: {
          include: { author: true, task: true, reviews: true },
          orderBy: [{ mergedAt: 'asc' }, { createdAt: 'asc' }],
        },
        contributionScores: {
          include: { user: true },
          orderBy: { totalScore: 'desc' },
        },
        scoreOverrides: {
          include: { user: true, overrider: true },
          orderBy: { createdAt: 'asc' },
        },
        auditLogs: {
          include: { actor: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const memberSummaries = this.buildProjectMemberSummaries(project);
    const projectManagers = project.members
      .filter((member) => member.role === 'PROJECT_MANAGER')
      .map((member) => this.getUserName(member.user));
    const activeContributors = memberSummaries.filter(
      (member) => member.doneTasks > 0 || member.mergedPrs > 0,
    );

    const reportData = {
      project: {
        name: project.name,
        organization: project.department.organization.name,
        department: project.department.name,
        repository: project.repository,
        externalProjectId: project.externalProjectId || 'N/A',
        status:
          project.status === ProjectStatus.LOCKED
            ? 'LOCKED (FINAL)'
            : project.status,
        evalStart: project.evalStart,
        evalEnd: project.evalEnd,
        lockedAt: project.lockedAt,
        generatedAt: new Date(),
      },
      leadership: {
        projectManagers: projectManagers.length
          ? projectManagers
          : ['Not assigned'],
      },
      summary: {
        totalMembers: project.members.length,
        activeContributors: activeContributors.length,
        totalTasks: project.tasks.length,
        doneTasks: project.tasks.filter((task) => task.status === 'DONE')
          .length,
        mergedPrs: project.pullRequests.filter((pr) => pr.status === 'MERGED')
          .length,
        averageDoneTasks:
          activeContributors.length === 0
            ? 0
            : Number(
                (
                  activeContributors.reduce(
                    (total, member) => total + member.doneTasks,
                    0,
                  ) / activeContributors.length
                ).toFixed(2),
              ),
      },
      members: memberSummaries,
      tasks: project.tasks.map((task) => {
        const linkedPr = task.pullRequests.find((pr) => pr.status === 'MERGED');
        return {
          taskId: task.externalTaskId,
          title: task.title,
          assignee: this.getUserName(task.assignee),
          status: task.status,
          linkedPr: linkedPr?.externalPrId || 'N/A',
          prStatus: linkedPr?.status || 'N/A',
          mergedAt: linkedPr?.mergedAt || null,
          score: this.findTaskScoreForUser(
            project.contributionScores,
            task.assigneeId,
            task.externalTaskId,
          ),
        };
      }),
      overrides: project.scoreOverrides.map((override) => ({
        student: this.getUserName(override.user),
        delta: override.delta,
        reason: override.reason,
        overriddenBy: this.getUserName(override.overrider),
        createdAt: override.createdAt,
      })),
      auditLogs: project.auditLogs.map((auditLog) => ({
        action: auditLog.action,
        actor: this.getUserName(auditLog.actor),
        createdAt: auditLog.createdAt,
        metadata: JSON.stringify(auditLog.metadata),
      })),
    };

    return this.pdfService.generateProjectReport(reportData);
  }

  async exportProjectCsv(
    projectId: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<string> {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      projectId,
    );

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: { include: { user: true } },
        tasks: true,
        pullRequests: { include: { reviews: true } },
        contributionScores: {
          include: { user: true },
          orderBy: { totalScore: 'desc' },
        },
        scoreOverrides: true,
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const data = this.buildProjectMemberSummaries(project).map(
      (member, index) => ({
        rank: index + 1,
        student_name: member.name,
        github_username: member.githubUsername,
        email: member.email,
        project_role: member.projectRole,
        total_score: member.totalScore,
        tasks_done: member.doneTasks,
        merged_prs: member.mergedPrs,
        approved_reviews: member.approvedReviews,
        override_delta: member.overrideDelta,
        last_score_updated: member.lastScoreUpdated?.toISOString() || '',
      }),
    );

    const parser = new Parser({
      fields: [
        'rank',
        'student_name',
        'github_username',
        'email',
        'project_role',
        'total_score',
        'tasks_done',
        'merged_prs',
        'approved_reviews',
        'override_delta',
        'last_score_updated',
      ],
    });

    return `\uFEFF${parser.parse(data)}`;
  }

  async exportOrganizationCsv(
    organizationId: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<string> {
    await this.organizationAccessService.assertCanManageOrganization(
      actorId,
      actorRoles,
      organizationId,
    );

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    });

    if (!organization) throw new NotFoundException('Organization not found');

    const projects = await this.prisma.project.findMany({
      where: { department: { organizationId } },
      include: this.scopeExportProjectInclude(),
      orderBy: { name: 'asc' },
    });

    return this.exportScopeCsv(
      'organization',
      organization.id,
      organization.name,
      projects,
    );
  }

  async exportDepartmentCsv(
    departmentId: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<string> {
    await this.departmentAccessService.assertCanManageDepartment(
      actorId,
      actorRoles,
      departmentId,
    );

    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true, name: true },
    });

    if (!department) throw new NotFoundException('Department not found');

    const projects = await this.prisma.project.findMany({
      where: { departmentId },
      include: this.scopeExportProjectInclude(),
      orderBy: { name: 'asc' },
    });

    return this.exportScopeCsv(
      'department',
      department.id,
      department.name,
      projects,
    );
  }

  private getScoreSummary(breakdown: ScoreBreakdown): ScoreSummary {
    return {
      taskCompletionPoints: this.sumScores(breakdown.TASK_COMPLETED),
      reviewPoints: this.sumScores(breakdown.REVIEWS),
      overrideDelta: this.sumScores(breakdown.OVERRIDES),
    };
  }

  private scopeExportProjectInclude() {
    return {
      department: { include: { organization: true } },
      members: { include: { user: true } },
      tasks: true,
      pullRequests: { include: { reviews: true } },
      contributionScores: {
        include: { user: true },
        orderBy: { totalScore: 'desc' as const },
      },
      scoreOverrides: true,
    } as const;
  }

  private exportScopeCsv(
    scopeType: 'organization' | 'department',
    scopeId: string,
    scopeName: string,
    projects: ScopeExportProject[],
  ) {
    const rows = projects.flatMap((project) =>
      this.buildProjectMemberSummaries(project).map((member, index) => ({
        scope_type: scopeType,
        scope_id: scopeId,
        scope_name: scopeName,
        organization: project.department.organization.name,
        department: project.department.name,
        project_id: project.id,
        project_name: project.name,
        project_status: project.status,
        rank_in_project: index + 1,
        student_name: member.name,
        github_username: member.githubUsername,
        email: member.email,
        project_role: member.projectRole,
        total_score: member.totalScore,
        tasks_done: member.doneTasks,
        merged_prs: member.mergedPrs,
        approved_reviews: member.approvedReviews,
        override_delta: member.overrideDelta,
        last_score_updated: member.lastScoreUpdated?.toISOString() || '',
      })),
    );

    const parser = new Parser({
      fields: [
        'scope_type',
        'scope_id',
        'scope_name',
        'organization',
        'department',
        'project_id',
        'project_name',
        'project_status',
        'rank_in_project',
        'student_name',
        'github_username',
        'email',
        'project_role',
        'total_score',
        'tasks_done',
        'merged_prs',
        'approved_reviews',
        'override_delta',
        'last_score_updated',
      ],
    });

    return `\uFEFF${parser.parse(rows)}`;
  }

  private sumScores(entries: Array<{ score: number }> | undefined): number {
    return (entries || []).reduce((total, entry) => total + entry.score, 0);
  }

  private findTaskScore(
    breakdown: ScoreBreakdown,
    externalTaskId?: string,
  ): number {
    if (!externalTaskId) return 0;

    return (
      (breakdown.TASK_COMPLETED || []).find(
        (entry) => entry.task === externalTaskId,
      )?.score ||
      (breakdown.PR_MERGED || []).find((entry) => entry.task === externalTaskId)
        ?.score ||
      0
    );
  }

  private findTaskScoreForUser(
    scores: Array<{ userId: string; breakdown: unknown }>,
    userId: string,
    externalTaskId: string,
  ): number {
    const score = scores.find((entry) => entry.userId === userId);
    if (!score) return 0;

    return this.findTaskScore(
      score.breakdown as unknown as ScoreBreakdown,
      externalTaskId,
    );
  }

  private getIndividualWarnings(
    pullRequests: Array<{
      status: string;
      taskId: string | null;
      externalPrId: string;
    }>,
    assignedTasks: Array<{
      externalTaskId: string;
      status: string;
      pullRequests: Array<{ status: string }>;
    }>,
  ): string[] {
    const warnings: string[] = [];
    const openPrs = pullRequests.filter((pr) => pr.status === 'OPEN').length;
    const unlinkedPrs = pullRequests.filter((pr) => !pr.taskId).length;
    const doneWithoutMergedPr = assignedTasks.filter(
      (task) =>
        task.status === 'DONE' &&
        !task.pullRequests.some((pr) => pr.status === 'MERGED'),
    ).length;

    if (openPrs > 0) warnings.push(`${openPrs} PR(s) are still open`);
    if (unlinkedPrs > 0) warnings.push(`${unlinkedPrs} PR(s) are not linked`);
    if (doneWithoutMergedPr > 0) {
      warnings.push(
        `${doneWithoutMergedPr} Done task(s) have no merged PR evidence`,
      );
    }

    return warnings.length ? warnings : ['No report warnings detected'];
  }

  private buildProjectMemberSummaries(project: {
    members: Array<{
      userId: string;
      role: string;
      user: {
        name: string | null;
        githubUsername: string | null;
        email: string | null;
      };
    }>;
    tasks: Array<{ assigneeId: string; status: string }>;
    pullRequests: Array<{
      authorId: string;
      status: string;
      reviews?: Array<{ reviewerId: string; state: string }>;
    }>;
    contributionScores: Array<{
      userId: string;
      totalScore: number;
      updatedAt: Date;
      user: {
        id: string;
        name: string | null;
        githubUsername: string | null;
        email: string | null;
      };
      breakdown: unknown;
    }>;
    scoreOverrides: Array<{ userId: string; delta: number }>;
  }): ProjectMemberSummary[] {
    const members = new Map<string, ProjectMemberSummary>();

    project.members.forEach((member) => {
      members.set(member.userId, {
        userId: member.userId,
        name: this.getUserName(member.user),
        githubUsername: member.user.githubUsername || '',
        email: member.user.email || '',
        projectRole: member.role,
        totalScore: 0,
        doneTasks: 0,
        mergedPrs: 0,
        approvedReviews: 0,
        overrideDelta: 0,
        lastScoreUpdated: null,
      });
    });

    project.contributionScores.forEach((score) => {
      const current =
        members.get(score.userId) ||
        ({
          userId: score.userId,
          name: this.getUserName(score.user),
          githubUsername: score.user.githubUsername || '',
          email: score.user.email || '',
          projectRole: 'PROJECT_MEMBER',
          totalScore: 0,
          doneTasks: 0,
          mergedPrs: 0,
          approvedReviews: 0,
          overrideDelta: 0,
          lastScoreUpdated: null,
        } satisfies ProjectMemberSummary);

      current.totalScore = score.totalScore;
      current.lastScoreUpdated = score.updatedAt;
      members.set(score.userId, current);
    });

    project.tasks.forEach((task) => {
      if (task.status !== 'DONE') return;
      const member = members.get(task.assigneeId);
      if (member) member.doneTasks += 1;
    });

    project.pullRequests.forEach((pr) => {
      const member = members.get(pr.authorId);
      if (!member) return;
      if (pr.status === 'MERGED') member.mergedPrs += 1;
      (pr.reviews || []).forEach((review) => {
        const reviewer = members.get(review.reviewerId);
        if (reviewer && review.state === 'APPROVED') {
          reviewer.approvedReviews += 1;
        }
      });
    });

    project.scoreOverrides.forEach((override) => {
      const member = members.get(override.userId);
      if (member) member.overrideDelta += override.delta;
    });

    return Array.from(members.values()).sort(
      (a, b) => b.totalScore - a.totalScore || a.name.localeCompare(b.name),
    );
  }

  private getUserName(user: {
    name: string | null;
    githubUsername: string | null;
  }): string {
    return user.name || user.githubUsername || 'Unknown user';
  }
}

type ScopeExportProject = {
  id: string;
  name: string;
  status: string;
  department: {
    name: string;
    organization: { name: string };
  };
  members: Array<{
    userId: string;
    role: string;
    user: {
      name: string | null;
      githubUsername: string | null;
      email: string | null;
    };
  }>;
  tasks: Array<{ assigneeId: string; status: string }>;
  pullRequests: Array<{
    authorId: string;
    status: string;
    reviews?: Array<{ reviewerId: string; state: string }>;
  }>;
  contributionScores: Array<{
    userId: string;
    totalScore: number;
    updatedAt: Date;
    user: {
      id: string;
      name: string | null;
      githubUsername: string | null;
      email: string | null;
    };
    breakdown: unknown;
  }>;
  scoreOverrides: Array<{ userId: string; delta: number }>;
};
