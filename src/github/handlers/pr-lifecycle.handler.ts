import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubService } from '../github.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Project, Task, PullRequest } from '../../generated/prisma';
import { safeUserSelect } from '../../common/serialization/safe-user-select';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';
import { repositoryProjectWhere } from '../repository-normalization';
import {
  GitHubPullRequestEventPayload,
  GitHubPullRequestPayload,
  GitHubInstallationPayload,
  GitHubRepositoryPayload,
} from '../github-payloads';

/**
 * PR Lifecycle Handler (spec §5, §6)
 *
 * Handles pull_request events: opened, synchronize, closed (merged/unmerged)
 *
 * Processing pipeline:
 *   Extract PR metadata → Parse task ID → Validate task & assignee →
 *   Persist PR → If merged → emit one task-completion contribution event
 *
 * Strict Mode Rules:
 *   - Missing task ID → PR persisted with taskId: null (INVALID)
 *   - Task not found → same treatment
 *   - PR author ≠ task assignee → FLAG in audit_logs
 *   - Project LOCKED + new PR → REJECT
 *   - Multiple PRs per task: first merged = primary, others = supporting
 */
@Injectable()
export class PrLifecycleHandler {
  private readonly logger = new Logger(PrLifecycleHandler.name);

  constructor(
    private prisma: PrismaService,
    private githubService: GitHubService,
    private eventEmitter: EventEmitter2,
    private projectLockGuard: ProjectLockGuardService,
  ) {}

  /**
   * Main entry point for pull_request webhook events
   */
  async handle(payload: GitHubPullRequestEventPayload): Promise<void> {
    const { action, pull_request, repository } = payload;

    if (!pull_request || !repository) {
      this.logger.warn('Invalid pull_request payload: missing required fields');
      return;
    }

    this.logger.log(
      `PR ${action}: #${pull_request.number} "${pull_request.title}" in ${repository.full_name}`,
    );

    // Find the project by repository full name
    const project = await this.prisma.project.findFirst({
      where: repositoryProjectWhere(repository.full_name),
    });

    if (!project) {
      this.logger.warn(
        `No project found for repository ${repository.full_name}`,
      );
      return;
    }

    if (this.projectLockGuard.isLocked(project)) {
      this.logger.warn(
        `Ignoring pull_request ${action} for locked project ${project.id}`,
      );
      return;
    }

    switch (action) {
      case 'opened':
      case 'synchronize':
        await this.handleOpenedOrSync(
          project,
          pull_request,
          action,
          payload.installation,
          repository,
        );
        break;
      case 'closed':
        await this.handleClosed(project, pull_request);
        break;
      default:
        this.logger.debug(`Ignoring PR action: ${action}`);
    }
  }

  /**
   * Handle PR opened or synchronize (new commits pushed)
   */
  private async handleOpenedOrSync(
    project: Project,
    pr: GitHubPullRequestPayload,
    action: string,
    installation: GitHubInstallationPayload | undefined,
    repository: GitHubRepositoryPayload,
  ): Promise<void> {
    // Parse task ID from title/body
    const taskId = this.parseTaskId(pr.title, pr.body);

    // Find the author in our DB
    const author = await this.findOrCreateUser(
      String(pr.user.id),
      pr.user.login,
      pr.user.avatar_url,
    );

    // Validate task linkage
    let task: (Task & { assignee: SafeUser }) | null = null;
    let validationStatus = 'VALID';
    let statusMessage = '';

    if (!taskId) {
      this.logger.warn(
        `No task ID found in PR #${pr.number} title/body — marked INVALID`,
      );
      validationStatus = 'INVALID';
      statusMessage = 'No task ID (e.g. TASK-42) found in PR title or body';
    } else {
      task = (await this.prisma.task.findUnique({
        where: {
          projectId_externalTaskId: {
            projectId: project.id,
            externalTaskId: taskId,
          },
        },
        include: { assignee: { select: safeUserSelect } },
      })) as (Task & { assignee: SafeUser }) | null;

      if (!task) {
        this.logger.warn(
          `Task ${taskId} not found for project ${project.id} — PR marked INVALID`,
        );
        validationStatus = 'INVALID';
        statusMessage = `Task ${taskId} not found in this project`;
      } else if (task.assignee.githubUserId !== String(pr.user.id)) {
        // PR author ≠ task assignee → FLAG
        this.logger.warn(
          `PR #${pr.number} author (${pr.user.login}) ≠ task ${taskId} assignee (${task.assignee.name}) — FLAGGED`,
        );
        validationStatus = 'FLAGGED';
        statusMessage = `Assignee mismatch: PR author is not assigned to ${taskId}`;

        await this.prisma.auditLog.create({
          data: {
            action: 'TASK_REASSIGN',
            actorId: author.id,
            projectId: project.id,
            metadata: {
              type: 'PR_ASSIGNEE_MISMATCH',
              prNumber: pr.number,
              taskId: taskId,
              prAuthor: pr.user.login,
              taskAssignee: task.assignee.name,
            },
          },
        });
      } else {
        statusMessage = `${taskId} verified`;
      }
    }

    // Persist/update PR record (upsert on projectId + externalPrId)
    await this.prisma.pullRequest.upsert({
      where: {
        projectId_externalPrId: {
          projectId: project.id,
          externalPrId: String(pr.number),
        },
      },
      create: {
        projectId: project.id,
        platform: 'GITHUB',
        externalPrId: String(pr.number),
        taskId: task?.id ?? null,
        authorId: author.id,
        title: pr.title,
        url: pr.html_url,
        status: 'OPEN',
      },
      update: {
        title: pr.title,
        url: pr.html_url,
        taskId: task?.id ?? undefined,
      },
    });

    this.logger.log(
      `PR #${pr.number} persisted (validation: ${validationStatus}, task: ${taskId ?? 'none'})`,
    );

    // Apply GitHub Commit Status Check
    if (
      installation?.id &&
      pr.head?.sha &&
      repository?.owner?.login &&
      repository?.name
    ) {
      const token = await this.githubService.getAppInstallationToken(
        String(installation.id),
      );
      if (token) {
        const stateMapping = {
          VALID: 'success',
          INVALID: 'failure',
          FLAGGED: 'failure', // Assignee mismatch blocks merge credit visually
        } as const;

        await this.githubService.createCommitStatus(
          repository.owner.login,
          repository.name,
          pr.head.sha,
          stateMapping[validationStatus as keyof typeof stateMapping],
          statusMessage,
          'Lime++ Validation',
          token,
        );
      }
    }
  }

  /**
   * Handle PR closed (merged or just closed)
   */
  /**
   * Handle PR closed (merged or just closed)
   */
  private async handleClosed(
    project: Project,
    pr: GitHubPullRequestPayload,
  ): Promise<void> {
    const isMerged = pr.merged === true;

    // Find the PR in our DB
    const existingPr = await this.prisma.pullRequest.findUnique({
      where: {
        projectId_externalPrId: {
          projectId: project.id,
          externalPrId: String(pr.number),
        },
      },
      include: { task: true },
    });

    if (!existingPr) {
      // PR not tracked (might have been opened before Lime++ was installed)
      // Create it now
      const author = await this.findOrCreateUser(
        String(pr.user.id),
        pr.user.login,
        pr.user.avatar_url,
      );

      const taskId = this.parseTaskId(pr.title, pr.body);
      let task: Task | null = null;
      if (taskId) {
        task = await this.prisma.task.findUnique({
          where: {
            projectId_externalTaskId: {
              projectId: project.id,
              externalTaskId: taskId,
            },
          },
        });
      }

      await this.prisma.pullRequest.create({
        data: {
          projectId: project.id,
          platform: 'GITHUB',
          externalPrId: String(pr.number),
          taskId: task?.id ?? null,
          authorId: author.id,
          title: pr.title,
          url: pr.html_url,
          status: isMerged ? 'MERGED' : 'CLOSED',
          mergedAt: isMerged && pr.merged_at ? new Date(pr.merged_at) : null,
        },
      });

      if (isMerged && task && task.assigneeId === author.id) {
        const mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
        await this.emitTaskCompletionEvent(project, task, author.id, mergedAt);
      } else if (isMerged && task) {
        this.logger.warn(
          `PR #${pr.number} merged by non-assignee - no contribution event emitted`,
        );
      }
      return;
    }

    if (isMerged) {
      await this.handleMerge(
        project,
        existingPr as PullRequest & { task: Task | null },
        pr,
      );
    } else {
      // Closed without merge
      await this.prisma.pullRequest.update({
        where: { id: existingPr.id },
        data: { status: 'CLOSED' },
      });
      this.logger.log(`PR #${pr.number} closed without merge`);
    }
  }

  /**
   * Handle PR merge — the critical scoring path (spec §6)
   *
   * Guarantees:
   *   - Only first merged PR per task emits contribution events
   *   - Task completion timestamp is immutable
   */
  private async handleMerge(
    project: Project,
    existingPr: PullRequest & { task: Task | null },
    prPayload: GitHubPullRequestPayload,
  ): Promise<void> {
    // Update PR status to MERGED
    await this.prisma.pullRequest.update({
      where: { id: existingPr.id },
      data: {
        status: 'MERGED',
        mergedAt: prPayload.merged_at
          ? new Date(prPayload.merged_at)
          : new Date(),
      },
    });

    if (!existingPr.taskId || !existingPr.task) {
      this.logger.warn(
        `PR #${prPayload.number} merged but has no linked task — no contribution events`,
      );
      return;
    }

    if (existingPr.task.assigneeId !== existingPr.authorId) {
      this.logger.warn(
        `PR #${prPayload.number} merged by non-assignee - no contribution event emitted`,
      );
      return;
    }

    // Check if task already has a merged PR (multiple PRs per task support)
    const existingMergedPr = await this.prisma.pullRequest.findFirst({
      where: {
        taskId: existingPr.taskId,
        status: 'MERGED',
        id: { not: existingPr.id },
      },
    });

    if (existingMergedPr) {
      this.logger.log(
        `Task ${existingPr.task.externalTaskId} already has merged PR — this PR recorded as supporting evidence`,
      );
      return;
    }

    const mergedAt = prPayload.merged_at
      ? new Date(prPayload.merged_at)
      : new Date();

    // First merged PR for this task → emit the single scoring event
    await this.emitTaskCompletionEvent(
      project,
      existingPr.task,
      existingPr.authorId,
      mergedAt,
    );
  }

  /**
   * Emit a single TASK_COMPLETED contribution event.
   *
   * The merged PR is evidence for completion; the task is the scoring unit.
   */
  private async emitTaskCompletionEvent(
    project: Project,
    task: Task,
    authorId: string,
    completedAt: Date,
  ): Promise<void> {
    // A kanban move to Done does not set completedAt. The merge timestamp does.
    if (task.status !== 'DONE' || !task.completedAt) {
      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: 'DONE',
          completedAt,
        },
      });
    }

    // Emit TASK_COMPLETED contribution event (base score: 10)
    await this.prisma.contributionEvent.upsert({
      where: {
        projectId_userId_type_referenceId: {
          projectId: project.id,
          userId: authorId,
          type: 'TASK_COMPLETED',
          referenceId: task.id,
        },
      },
      create: {
        projectId: project.id,
        userId: authorId,
        type: 'TASK_COMPLETED',
        referenceId: task.id,
        score: 10,
      },
      update: { score: 10 },
    });

    this.logger.log(
      `Contribution event emitted for task ${task.externalTaskId}: TASK_COMPLETED(+10)`,
    );

    this.eventEmitter.emit('contribution.created', { projectId: project.id });
  }

  /**
   * Parse task ID from PR title or body (spec §6.1, §6.2)
   *
   * Matches format: TASK-<code>
   * Checks title first, then body.
   *
   * @returns Task ID string (e.g., "TASK-42") or null
   */
  parseTaskId(title: string, body: string | null): string | null {
    const regex = /\bTASK-([A-Za-z0-9_-]+)\b/i;
    const titleMatch = title.match(regex);
    if (titleMatch) return `TASK-${titleMatch[1]}`;
    const bodyMatch = body?.match(regex);
    if (bodyMatch) return `TASK-${bodyMatch[1]}`;
    return null;
  }

  /**
   * Find a user by GitHub user ID, or auto-create a minimal record
   *
   * This ensures we never miss a contribution because a user
   * isn't yet registered in Lime++.
   */
  private async findOrCreateUser(
    githubUserId: string,
    login: string,
    avatarUrl?: string,
  ) {
    let user = await this.prisma.user.findUnique({
      where: { githubUserId },
    });

    if (!user) {
      this.logger.log(
        `Auto-creating user record for GitHub user ${login} (${githubUserId})`,
      );
      user = await this.prisma.user.create({
        data: {
          githubUserId,
          githubUsername: login,
          name: login,
          avatarUrl: avatarUrl ?? null,
        },
      });
    }

    return user;
  }
}

type SafeUser = {
  id: string;
  githubUserId: string;
  githubUsername: string | null;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  createdAt: Date;
};
