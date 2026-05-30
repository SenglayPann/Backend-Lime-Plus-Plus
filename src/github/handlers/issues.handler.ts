import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { Project, TaskStatus } from '../../generated/prisma';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';
import { repositoryProjectWhere } from '../repository-normalization';
import { auditIgnoredLockedWebhook } from '../audit-ignored-locked-event';
import { findOrCreateGitHubUser } from '../github-user-resolution';
import { GitHubIssuesEventPayload, GitHubIssuePayload } from '../github-payloads';
import type { ProjectUpdatePayload } from '../project-events.service';

/**
 * Issues Handler
 *
 * Mirrors task state from GitHub Issues that aren't surfaced through the
 * projects_v2_item stream (e.g. an issue edited outside the project board).
 * Keeps Kanban cards live for title/assignee/closed changes.
 */
@Injectable()
export class IssuesHandler {
  private readonly logger = new Logger(IssuesHandler.name);

  constructor(
    private prisma: PrismaService,
    private projectLockGuard: ProjectLockGuardService,
    private eventEmitter: EventEmitter2,
  ) {}

  async handle(payload: GitHubIssuesEventPayload): Promise<void> {
    const { action, issue, repository, sender } = payload;

    if (!issue || !repository) {
      this.logger.warn('Invalid issues payload: missing required fields');
      return;
    }

    this.logger.log(
      `Issue ${action}: #${issue.number} "${issue.title}" in ${repository.full_name}`,
    );

    const project = await this.prisma.project.findFirst({
      where: repositoryProjectWhere(repository.full_name, repository.id),
    });

    if (!project) {
      this.logger.debug(
        `No project found for repository ${repository.full_name} — ignoring issue ${action}`,
      );
      return;
    }

    if (this.projectLockGuard.isLocked(project)) {
      await auditIgnoredLockedWebhook(this.prisma, project, sender, {
        event: 'issues',
        action,
        repository: repository.full_name,
        issueNumber: issue.number,
      });
      return;
    }

    const externalTaskId = `TASK-${issue.number}`;
    const task = await this.prisma.task.findUnique({
      where: {
        projectId_externalTaskId: {
          projectId: project.id,
          externalTaskId,
        },
      },
    });

    if (!task) {
      this.logger.debug(
        `No task found for issue #${issue.number} — likely not added to the project board yet`,
      );
      return;
    }

    let mutated = false;

    switch (action) {
      case 'edited': {
        const titleChanged = await this.syncTitle(task.id, task.title, issue);
        const descChanged = await this.syncDescription(
          task.id,
          task.description,
          issue,
        );
        mutated = titleChanged || descChanged;
        break;
      }
      case 'closed':
        mutated = await this.applyStatus(task.id, task.status, 'DONE');
        break;
      case 'reopened':
        mutated = await this.applyStatus(task.id, task.status, 'TODO');
        break;
      case 'assigned':
      case 'unassigned':
        mutated = await this.syncAssignee(task.id, task.assigneeId, issue);
        break;
      case 'labeled':
      case 'unlabeled':
        // Labels don't currently map to a structured field on Task, but the
        // Kanban UI may show them via the GitHub link. Emit so the client
        // refreshes; no DB write needed.
        mutated = true;
        break;
      default:
        this.logger.debug(`Ignoring issues action: ${action}`);
        return;
    }

    if (mutated) {
      const updatePayload: ProjectUpdatePayload = {
        projectId: project.id,
        kind: 'issue',
        at: new Date().toISOString(),
      };
      this.eventEmitter.emit('project.updated', updatePayload);
    }
  }

  private async syncTitle(
    taskId: string,
    currentTitle: string,
    issue: GitHubIssuePayload,
  ): Promise<boolean> {
    if (!issue.title || issue.title === currentTitle) return false;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { title: issue.title },
    });
    return true;
  }

  /**
   * Mirror the GitHub Issue body onto Task.description. Treats null/undefined
   * issue body as an empty description so deleting the issue body clears the
   * Lime++ field as well.
   */
  private async syncDescription(
    taskId: string,
    currentDescription: string | null,
    issue: GitHubIssuePayload,
  ): Promise<boolean> {
    const next = issue.body ?? null;
    if (next === currentDescription) return false;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { description: next },
    });
    return true;
  }

  private async applyStatus(
    taskId: string,
    currentStatus: TaskStatus,
    next: TaskStatus,
  ): Promise<boolean> {
    if (currentStatus === next) return false;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: next },
    });
    return true;
  }

  private async syncAssignee(
    taskId: string,
    currentAssigneeId: string | null,
    issue: GitHubIssuePayload,
  ): Promise<boolean> {
    const first = issue.assignees?.[0];
    if (!first) {
      if (currentAssigneeId === null) return false;
      await this.prisma.task.update({
        where: { id: taskId },
        data: { assigneeId: null },
      });
      return true;
    }

    const assignee = await findOrCreateGitHubUser(this.prisma, {
      githubUserId: String(first.id),
      login: first.login,
      avatarUrl: first.avatar_url,
    });

    if (assignee.id === currentAssigneeId) return false;
    await this.prisma.task.update({
      where: { id: taskId },
      data: { assigneeId: assignee.id },
    });
    return true;
  }
}
