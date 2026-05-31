import {
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from './pdf.service';
import { Parser } from 'json2csv';
import { Prisma, ProjectStatus } from '../../generated/prisma';
import { ScoreBreakdown } from '../../scoring/scoring.service';
import { ProjectAccessService } from '../access/project-access.service';
import { OrganizationAccessService } from '../access/organization-access.service';
import { DepartmentAccessService } from '../access/department-access.service';
import { safeUserSelect } from '../serialization/safe-user-select';
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

const MAX_SYNC_PROJECT_EXPORT_RECORDS = 5_000;
const MAX_SYNC_SCOPE_EXPORT_RECORDS = 10_000;

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private pdfService: PdfService,
    private projectAccessService: ProjectAccessService,
    private organizationAccessService: OrganizationAccessService,
    private departmentAccessService: DepartmentAccessService,
    private configService: ConfigService,
  ) {}

  /**
   * Look up a generated report by its public verification ID. Returns
   * `null` if it doesn't exist. Used by the public verify endpoint —
   * does not enforce auth on its own (the controller does that).
   */
  async findVerification(id: string) {
    const row = await this.prisma.generatedReport.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            repository: true,
            department: {
              select: { name: true, organization: { select: { name: true } } },
            },
          },
        },
        subjectUser: { select: safeUserSelect },
        generatedBy: { select: safeUserSelect },
      },
    });
    return row;
  }

  /**
   * Persist a verification row for a generated report and return the
   * verification block to stamp on the PDF. The hash covers a canonical
   * JSON serialization of the report payload, so a recipient can confirm
   * the printed numbers match the snapshot Lime++ stored. The signature
   * binds the row id to the hash with a server-side secret so even
   * direct-db tampering is detectable.
   */
  private async createReportVerification(args: {
    type: 'individual' | 'project';
    projectId: string;
    subjectUserId: string | null;
    generatedByUserId: string;
    data: unknown;
    summary: Record<string, unknown>;
  }) {
    const canonical = canonicalize(args.data);
    const dataHash = createHash('sha256').update(canonical).digest('hex');

    const row = await this.prisma.generatedReport.create({
      data: {
        type: args.type,
        projectId: args.projectId,
        subjectUserId: args.subjectUserId,
        generatedByUserId: args.generatedByUserId,
        dataHash,
        signature: '',
        summary: args.summary as Prisma.InputJsonValue,
      },
    });

    const secret =
      this.configService.get<string>('REPORT_VERIFICATION_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      'dev-fallback-secret';
    const signature = createHmac('sha256', secret)
      .update(`${row.id}:${dataHash}`)
      .digest('hex');

    await this.prisma.generatedReport.update({
      where: { id: row.id },
      data: { signature },
    });

    const baseUrl =
      this.configService.get<string>('PUBLIC_VERIFY_BASE_URL') ||
      this.configService.get<string>('PUBLIC_FRONTEND_URL') ||
      'http://localhost:3000';

    return {
      id: row.id,
      hash: dataHash,
      verifyUrl: `${baseUrl.replace(/\/$/, '')}/verify/${row.id}`,
      generatedAt: row.generatedAt,
    };
  }

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
        user: { select: safeUserSelect },
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
          include: { overrider: { select: safeUserSelect } },
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

    const verification = await this.createReportVerification({
      type: 'individual',
      projectId,
      subjectUserId: userId,
      generatedByUserId: actorId,
      data: reportData,
      summary: {
        student: reportData.student.name,
        totalScore: reportData.score.totalScore,
        mergedPrs: reportData.contributionEvidence.length,
      },
    });

    return this.pdfService.generateIndividualReport({ ...reportData, verification });
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
    await this.assertProjectExportWithinSyncLimitBeforeLoad(
      projectId,
      'Project PDF report',
      true,
    );

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        department: { include: { organization: true } },
        members: { include: { user: { select: safeUserSelect } } },
        tasks: {
          include: {
            assignee: { select: safeUserSelect },
            pullRequests: {
              include: { author: { select: safeUserSelect } },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { externalTaskId: 'asc' },
        },
        pullRequests: {
          include: {
            author: { select: safeUserSelect },
            task: true,
            reviews: true,
          },
          orderBy: [{ mergedAt: 'asc' }, { createdAt: 'asc' }],
        },
        contributionScores: {
          include: { user: { select: safeUserSelect } },
          orderBy: { totalScore: 'desc' },
        },
        scoreOverrides: {
          include: {
            user: { select: safeUserSelect },
            overrider: { select: safeUserSelect },
          },
          orderBy: { createdAt: 'asc' },
        },
        auditLogs: {
          include: { actor: { select: safeUserSelect } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');
    this.assertProjectExportWithinSyncLimit(project, 'Project PDF report');

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
          score: task.assigneeId
            ? this.findTaskScoreForUser(
                project.contributionScores,
                task.assigneeId,
                task.externalTaskId,
              )
            : 0,
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
        metadata: this.formatAuditMetadata(
          auditLog.action,
          auditLog.metadata,
        ),
      })),
    };

    const verification = await this.createReportVerification({
      type: 'project',
      projectId,
      subjectUserId: null,
      generatedByUserId: actorId,
      data: reportData,
      summary: {
        project: reportData.project.name,
        totalMembers: reportData.summary.totalMembers,
        doneTasks: reportData.summary.doneTasks,
        mergedPrs: reportData.summary.mergedPrs,
      },
    });

    return this.pdfService.generateProjectReport({ ...reportData, verification });
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
    await this.assertProjectExportWithinSyncLimitBeforeLoad(
      projectId,
      'Project CSV export',
      false,
    );

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: { include: { user: { select: safeUserSelect } } },
        tasks: true,
        pullRequests: { include: { reviews: true } },
        contributionScores: {
          include: { user: { select: safeUserSelect } },
          orderBy: { totalScore: 'desc' },
        },
        scoreOverrides: true,
      },
    });

    if (!project) throw new NotFoundException('Project not found');
    this.assertProjectExportWithinSyncLimit(project, 'Project CSV export');

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
        { label: 'Rank', value: 'rank' },
        { label: 'Student Name', value: 'student_name' },
        { label: 'GitHub Username', value: 'github_username' },
        { label: 'Email', value: 'email' },
        { label: 'Project Role', value: 'project_role' },
        { label: 'Total Score', value: 'total_score' },
        { label: 'Tasks Done', value: 'tasks_done' },
        { label: 'Merged PRs', value: 'merged_prs' },
        { label: 'Approved Reviews', value: 'approved_reviews' },
        { label: 'Override Delta', value: 'override_delta' },
        { label: 'Last Score Updated', value: 'last_score_updated' },
      ],
    });

    return `\uFEFF${parser.parse(this.sanitizeCsvRows(data))}`;
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

    const organizationProjectWhere = { department: { organizationId } };
    await this.assertScopeExportWithinSyncLimitBeforeLoad(
      organizationProjectWhere,
      'Organization CSV export',
    );

    const projects = await this.prisma.project.findMany({
      where: organizationProjectWhere,
      include: this.scopeExportProjectInclude(),
      orderBy: { name: 'asc' },
    });

    this.assertScopeExportWithinSyncLimit(projects, 'Organization CSV export');

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

    const departmentProjectWhere = { departmentId };
    await this.assertScopeExportWithinSyncLimitBeforeLoad(
      departmentProjectWhere,
      'Department CSV export',
    );

    const projects = await this.prisma.project.findMany({
      where: departmentProjectWhere,
      include: this.scopeExportProjectInclude(),
      orderBy: { name: 'asc' },
    });

    this.assertScopeExportWithinSyncLimit(projects, 'Department CSV export');

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

  private formatAuditMetadata(action: string, metadata: unknown): string {
    const data = this.asMetadataRecord(metadata);
    if (!data) return 'No details';

    if (action === 'ROLE_CHANGE') {
      return this.formatRoleChangeMetadata(data);
    }

    if (action === 'TASK_REASSIGN') {
      return this.formatTaskAuditMetadata(data);
    }

    if (action === 'PROJECT_LOCK') {
      return this.formatProjectLockMetadata(data);
    }

    if (action === 'SCORE_OVERRIDE') {
      return this.formatScoreOverrideMetadata(data);
    }

    if (action === 'WEBHOOK_IGNORED') {
      return this.formatWebhookIgnoredMetadata(data);
    }

    return this.formatGenericAuditMetadata(data);
  }

  private formatRoleChangeMetadata(data: Record<string, unknown>): string {
    const operation = this.humanizeOperation(data.operation);
    const role = this.formatRole(data.role);
    const previousRole = this.formatRole(data.previousRole);
    const scope = data.departmentId
      ? 'department scope'
      : data.organizationId
        ? 'organization scope'
        : data.projectId
          ? 'project scope'
          : 'global scope';

    const roleText =
      previousRole && previousRole !== 'N/A'
        ? `${previousRole} to ${role}`
        : role;

    return `${operation} ${roleText}; Scope: ${scope}`;
  }

  private formatTaskAuditMetadata(data: Record<string, unknown>): string {
    if (data.type === 'TASK_STATUS_CHANGE') {
      return `Task ${this.safeAuditValue(data.taskId)} status changed from ${this.safeAuditValue(data.previousStatus)} to ${this.safeAuditValue(data.newStatus)}`;
    }

    if (data.type === 'TASK_SOFT_DELETE') {
      return `Task ${this.safeAuditValue(data.taskId)} blocked after GitHub item deletion`;
    }

    if (data.type === 'PR_ASSIGNEE_MISMATCH') {
      return [
        `PR #${this.safeAuditValue(data.prNumber)}`,
        `author ${this.safeAuditValue(data.prAuthor)}`,
        `did not match ${this.safeAuditValue(data.taskId)} assignee ${this.safeAuditValue(data.taskAssignee)}`,
      ].join(' ');
    }

    const warning =
      data.hasOpenPRs === true ? '; Open PRs existed during reassignment' : '';
    return `Task ${this.safeAuditValue(data.taskId)} reassigned${warning}`;
  }

  private formatProjectLockMetadata(data: Record<string, unknown>): string {
    if (data.type === 'PROJECT_DELETED_ON_GITHUB') {
      return `GitHub project deleted; Previous status: ${this.safeAuditValue(data.previousStatus)}`;
    }

    if (data.type === 'PROJECT_CLOSED_ON_GITHUB') {
      return 'GitHub project closed';
    }

    if (data.previousStatus) {
      return `Previous status: ${this.safeAuditValue(data.previousStatus)}`;
    }

    return 'Project status finalized';
  }

  private formatScoreOverrideMetadata(data: Record<string, unknown>): string {
    const details = [`Score adjustment: ${this.safeAuditValue(data.delta)}`];
    if (data.reason) {
      details.push(`Reason: ${this.safeAuditValue(data.reason)}`);
    }
    return details.join('; ');
  }

  private formatWebhookIgnoredMetadata(data: Record<string, unknown>): string {
    return [
      `Ignored ${this.safeAuditValue(data.event)} ${this.safeAuditValue(data.action)}`,
      `Reason: ${this.safeAuditValue(data.reason)}`,
    ].join('; ');
  }

  private formatGenericAuditMetadata(data: Record<string, unknown>): string {
    const details = Object.entries(data)
      .filter(([key]) => !/(^id$|id$|ids$)/i.test(key))
      .map(([key, value]) => [this.humanizeKey(key), this.safeAuditValue(value)])
      .filter(([, value]) => value !== 'N/A')
      .map(([key, value]) => `${key}: ${value}`);

    return details.length > 0 ? details.join('; ') : 'Details omitted';
  }

  private asMetadataRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private humanizeOperation(value: unknown): string {
    const operation = typeof value === 'string' ? value : '';
    const labels: Record<string, string> = {
      assign: 'Assigned role',
      remove: 'Removed role',
      add_project_member: 'Added project member as',
      update_project_member: 'Updated project member from',
      remove_project_member: 'Removed project member with role',
    };

    return labels[operation] || this.humanizeKey(operation || 'Changed');
  }

  private humanizeKey(value: string): string {
    return value
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, (char) => char.toUpperCase());
  }

  private formatRole(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) return 'N/A';
    return value.replace(/_/g, ' ');
  }

  private safeAuditValue(value: unknown): string {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return String(value);
    }

    return 'N/A';
  }

  private scopeExportProjectInclude() {
    return {
      department: { include: { organization: true } },
      members: { include: { user: { select: safeUserSelect } } },
      tasks: true,
      pullRequests: { include: { reviews: true } },
      contributionScores: {
        include: { user: { select: safeUserSelect } },
        orderBy: { totalScore: 'desc' as const },
      },
      scoreOverrides: true,
    } as const;
  }

  private assertProjectExportWithinSyncLimit(
    project: ExportSizeProject,
    label: string,
  ) {
    const recordCount = this.countProjectExportRecords(project);

    this.assertRecordCountWithinLimit(
      recordCount,
      MAX_SYNC_PROJECT_EXPORT_RECORDS,
      label,
      'project data',
    );
  }

  private assertScopeExportWithinSyncLimit(
    projects: ExportSizeProject[],
    label: string,
  ) {
    const recordCount = projects.reduce(
      (total, project) => total + this.countProjectExportRecords(project),
      0,
    );

    this.assertRecordCountWithinLimit(
      recordCount,
      MAX_SYNC_SCOPE_EXPORT_RECORDS,
      label,
      'scope',
    );
  }

  private async assertProjectExportWithinSyncLimitBeforeLoad(
    projectId: string,
    label: string,
    includeAuditLogs: boolean,
  ) {
    const [
      members,
      tasks,
      pullRequests,
      contributionScores,
      scoreOverrides,
      auditLogs,
    ] = await Promise.all([
      this.prisma.projectMember.count({ where: { projectId } }),
      this.prisma.task.count({ where: { projectId } }),
      this.prisma.pullRequest.count({ where: { projectId } }),
      this.prisma.contributionScore.count({ where: { projectId } }),
      this.prisma.scoreOverride.count({ where: { projectId } }),
      includeAuditLogs
        ? this.prisma.auditLog.count({ where: { projectId } })
        : Promise.resolve(0),
    ]);

    this.assertRecordCountWithinLimit(
      members +
        tasks +
        pullRequests +
        contributionScores +
        scoreOverrides +
        auditLogs,
      MAX_SYNC_PROJECT_EXPORT_RECORDS,
      label,
      'project data',
    );
  }

  private async assertScopeExportWithinSyncLimitBeforeLoad(
    where: Prisma.ProjectWhereInput,
    label: string,
  ) {
    const projects = await this.prisma.project.findMany({
      where,
      select: { id: true },
    });
    const projectIds = projects.map((project) => project.id);

    if (projectIds.length === 0) {
      return;
    }

    const [
      members,
      tasks,
      pullRequests,
      contributionScores,
      scoreOverrides,
    ] = await Promise.all([
      this.prisma.projectMember.count({
        where: { projectId: { in: projectIds } },
      }),
      this.prisma.task.count({ where: { projectId: { in: projectIds } } }),
      this.prisma.pullRequest.count({
        where: { projectId: { in: projectIds } },
      }),
      this.prisma.contributionScore.count({
        where: { projectId: { in: projectIds } },
      }),
      this.prisma.scoreOverride.count({
        where: { projectId: { in: projectIds } },
      }),
    ]);

    this.assertRecordCountWithinLimit(
      members + tasks + pullRequests + contributionScores + scoreOverrides,
      MAX_SYNC_SCOPE_EXPORT_RECORDS,
      label,
      'scope',
    );
  }

  private assertRecordCountWithinLimit(
    recordCount: number,
    maxRecords: number,
    label: string,
    narrowTarget: string,
  ) {
    if (recordCount <= maxRecords) {
      return;
    }

    throw new PayloadTooLargeException(
      [
        `${label} is too large for synchronous download`,
        `(${recordCount} records).`,
        `Narrow the ${narrowTarget} or use a background export flow.`,
      ].join(' '),
    );
  }

  private countProjectExportRecords(project: ExportSizeProject): number {
    return (
      (project.members?.length ?? 0) +
      (project.tasks?.length ?? 0) +
      (project.pullRequests?.length ?? 0) +
      (project.contributionScores?.length ?? 0) +
      (project.scoreOverrides?.length ?? 0) +
      (project.auditLogs?.length ?? 0)
    );
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
        { label: 'Scope Type', value: 'scope_type' },
        { label: 'Scope ID', value: 'scope_id' },
        { label: 'Scope Name', value: 'scope_name' },
        { label: 'Organization', value: 'organization' },
        { label: 'Department', value: 'department' },
        { label: 'Project ID', value: 'project_id' },
        { label: 'Project Name', value: 'project_name' },
        { label: 'Project Status', value: 'project_status' },
        { label: 'Rank In Project', value: 'rank_in_project' },
        { label: 'Student Name', value: 'student_name' },
        { label: 'GitHub Username', value: 'github_username' },
        { label: 'Email', value: 'email' },
        { label: 'Project Role', value: 'project_role' },
        { label: 'Total Score', value: 'total_score' },
        { label: 'Tasks Done', value: 'tasks_done' },
        { label: 'Merged PRs', value: 'merged_prs' },
        { label: 'Approved Reviews', value: 'approved_reviews' },
        { label: 'Override Delta', value: 'override_delta' },
        { label: 'Last Score Updated', value: 'last_score_updated' },
      ],
    });

    return `\uFEFF${parser.parse(this.sanitizeCsvRows(rows))}`;
  }

  private sanitizeCsvRows<T extends Record<string, unknown>>(rows: T[]): T[] {
    return rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            this.sanitizeCsvValue(value),
          ]),
        ) as T,
    );
  }

  private sanitizeCsvValue(value: unknown): unknown {
    if (typeof value !== 'string' || value === '') return value;

    return /^[=+\-@\t\r\n]/.test(value) || /^\s+[=+\-@]/.test(value)
      ? `'${value}`
      : value;
  }

  private sumScores(entries: Array<{ score: number }> | undefined): number {
    return (entries || []).reduce((total, entry) => total + entry.score, 0);
  }

  private findTaskScore(
    breakdown: ScoreBreakdown,
    externalTaskId?: string,
  ): number {
    if (!externalTaskId) return 0;

    // Legacy fallback: old score rows persisted task scores under a
    // PR_MERGED breakdown key. New rows use TASK_COMPLETED. Reading both
    // keeps historical reports rendering. See scoring.service.ts for the
    // backwards-compat note on ScoreBreakdown.
    type TaskEntry = { task: string; score: number };
    const legacyEntries =
      (breakdown as Record<string, unknown>).PR_MERGED as
        | TaskEntry[]
        | undefined;

    return (
      (breakdown.TASK_COMPLETED || []).find(
        (entry) => entry.task === externalTaskId,
      )?.score ||
      (legacyEntries || []).find(
        (entry: TaskEntry) => entry.task === externalTaskId,
      )?.score ||
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
    tasks: Array<{ assigneeId: string | null; status: string }>;
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
      if (!task.assigneeId) return;
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
  } | null): string {
    if (!user) return 'Unassigned';
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
  tasks: Array<{ assigneeId: string | null; status: string }>;
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

type ExportSizeProject = {
  members?: unknown[];
  tasks?: unknown[];
  pullRequests?: unknown[];
  contributionScores?: unknown[];
  scoreOverrides?: unknown[];
  auditLogs?: unknown[];
};

/**
 * Deterministic JSON serialization for hashing. Standard JSON.stringify
 * preserves insertion order for object keys, which means the same logical
 * data can hash to different strings across runs. This sorts keys
 * recursively and turns Date values into ISO strings so the verification
 * hash is reproducible.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
      .join(',') +
    '}'
  );
}
