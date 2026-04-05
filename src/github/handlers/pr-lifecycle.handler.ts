import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubService } from '../github.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * PR Lifecycle Handler (spec §5, §6)
 *
 * Handles pull_request events: opened, synchronize, closed (merged/unmerged)
 *
 * Processing pipeline:
 *   Extract PR metadata → Parse task ID → Validate task & assignee →
 *   Persist PR → If merged → emit contribution events
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
  ) {}

  /**
   * Main entry point for pull_request webhook events
   */
  async handle(payload: any): Promise<void> {
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
      where: { repository: repository.full_name },
    });

    if (!project) {
      this.logger.warn(`No project found for repository ${repository.full_name}`);
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
    project: any,
    pr: any,
    action: string,
    installation: any,
    repository: any,
  ): Promise<void> {
    // Strict mode: reject new PRs on locked projects
    if (project.status === 'LOCKED' && action === 'opened') {
      this.logger.warn(
        `REJECT: PR #${pr.number} opened on locked project ${project.id}`,
      );
      return;
    }

    // Parse task ID from title/body
    const taskId = this.parseTaskId(pr.title, pr.body);

    // Find the author in our DB
    const author = await this.findOrCreateUser(
      String(pr.user.id),
      pr.user.login,
      pr.user.avatar_url,
    );

    // Validate task linkage
    let task = null;
    let validationStatus = 'VALID';
    let statusMessage = '';

    if (!taskId) {
      this.logger.warn(`No task ID found in PR #${pr.number} title/body — marked INVALID`);
      validationStatus = 'INVALID';
      statusMessage = 'No task ID (e.g. TASK-42) found in PR title or body';
    } else {
      task = await this.prisma.task.findUnique({
        where: {
          projectId_externalTaskId: {
            projectId: project.id,
            externalTaskId: taskId,
          },
        },
        include: { assignee: true },
      });

      if (!task) {
        this.logger.warn(`Task ${taskId} not found for project ${project.id} — PR marked INVALID`);
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
    if (installation?.id && pr.head?.sha && repository?.owner?.login && repository?.name) {
      const token = await this.githubService.getAppInstallationToken(String(installation.id));
      if (token) {
        const stateMapping = {
          'VALID': 'success',
          'INVALID': 'failure',
          'FLAGGED': 'failure', // Assignee mismatch blocks merge credit visually
        } as const;

        await this.githubService.createCommitStatus(
          repository.owner.login,
          repository.name,
          pr.head.sha,
          stateMapping[validationStatus as keyof typeof stateMapping],
          statusMessage,
          'Lime++ Validation',
          token
        );
      }
    }
  }

  /**
   * Handle PR closed (merged or just closed)
   */
  private async handleClosed(project: any, pr: any): Promise<void> {
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
      let task = null;
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
          mergedAt: isMerged ? new Date(pr.merged_at) : null,
        },
      });

      if (isMerged && task) {
        await this.emitMergeContributionEvents(project, task, author.id);
      }
      return;
    }

    if (isMerged) {
      await this.handleMerge(project, existingPr, pr);
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
  private async handleMerge(project: any, existingPr: any, prPayload: any): Promise<void> {
    // Update PR status to MERGED
    await this.prisma.pullRequest.update({
      where: { id: existingPr.id },
      data: {
        status: 'MERGED',
        mergedAt: new Date(prPayload.merged_at),
      },
    });

    if (!existingPr.taskId || !existingPr.task) {
      this.logger.warn(`PR #${prPayload.number} merged but has no linked task — no contribution events`);
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

    // First merged PR for this task → emit contribution events
    await this.emitMergeContributionEvents(project, existingPr.task, existingPr.authorId);
  }

  /**
   * Emit PR_MERGED and TASK_COMPLETED contribution events
   */
  private async emitMergeContributionEvents(
    project: any,
    task: any,
    authorId: string,
  ): Promise<void> {
    // Mark task as DONE (only if not already done)
    if (task.status !== 'DONE') {
      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: 'DONE',
          completedAt: new Date(),
        },
      });
    }

    // Emit PR_MERGED contribution event (base score: 10)
    await this.prisma.contributionEvent.create({
      data: {
        projectId: project.id,
        userId: authorId,
        type: 'PR_MERGED',
        referenceId: task.id,
        score: 10,
      },
    });

    // Emit TASK_COMPLETED contribution event (base score: 5)
    await this.prisma.contributionEvent.create({
      data: {
        projectId: project.id,
        userId: authorId,
        type: 'TASK_COMPLETED',
        referenceId: task.id,
        score: 5,
      },
    });

    this.logger.log(
      `Contribution events emitted for task ${task.externalTaskId}: PR_MERGED(+10), TASK_COMPLETED(+5)`,
    );

    this.eventEmitter.emit('contribution.created', { projectId: project.id });
  }

  /**
   * Parse task ID from PR title or body (spec §6.1, §6.2)
   *
   * Matches format: TASK-<number>
   * Checks title first, then body.
   *
   * @returns Task ID string (e.g., "TASK-42") or null
   */
  parseTaskId(title: string, body: string | null): string | null {
    const regex = /TASK-(\d+)/i;
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
      this.logger.log(`Auto-creating user record for GitHub user ${login} (${githubUserId})`);
      user = await this.prisma.user.create({
        data: {
          githubUserId,
          name: login,
          avatarUrl: avatarUrl ?? null,
        },
      });
    }

    return user;
  }
}
