import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction, Project } from '../../generated/prisma';
import { safeUserSelect } from '../../common/serialization/safe-user-select';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';
import type { ProjectUpdatePayload } from '../project-events.service';
import {
  GitHubProjectV2ItemEventPayload,
  GitHubProjectV2ItemPayload,
  GitHubUserPayload,
} from '../github-payloads';
import { auditIgnoredLockedWebhook } from '../audit-ignored-locked-event';
import { findOrCreateGitHubUser } from '../github-user-resolution';

/**
 * Task Sync Handler (spec §8)
 *
 * Handles projects_v2_item events to sync GitHub Project items to Lime++ tasks
 *
 * Processing pipeline:
 *   Extract item & field changes → Map to Lime++ task →
 *   Create or update task → Sync status & assignee
 *
 * Strict Rules:
 *   - Task ID generated and immutable (TASK-<number>)
 *   - Assignee change logged in audit_logs
 *   - Task reassignment after PR opened → FLAG
 */
@Injectable()
export class TaskSyncHandler {
  private readonly logger = new Logger(TaskSyncHandler.name);

  constructor(
    private prisma: PrismaService,
    private projectLockGuard: ProjectLockGuardService,
    private eventEmitter: EventEmitter2,
  ) {}

  private emitProjectUpdated(projectId: string) {
    const payload: ProjectUpdatePayload = {
      projectId,
      kind: 'task',
      at: new Date().toISOString(),
    };
    this.eventEmitter.emit('project.updated', payload);
  }

  /**
   * Main entry point for projects_v2_item webhook events
   */
  async handle(payload: GitHubProjectV2ItemEventPayload): Promise<void> {
    const { action, projects_v2_item, sender } = payload;

    if (!projects_v2_item) {
      this.logger.warn(
        'Invalid projects_v2_item payload: missing required fields',
      );
      return;
    }

    this.logger.log(
      `Project item ${action}: node_id=${projects_v2_item.node_id}`,
    );

    // Find the project by external project ID
    const projectNodeId = projects_v2_item.project_node_id;
    const project = await this.prisma.project.findFirst({
      where: { externalProjectId: projectNodeId },
    });

    if (!project) {
      this.logger.warn(
        `No project found for GitHub Project node ${projectNodeId}`,
      );
      return;
    }

    if (this.projectLockGuard.isLocked(project)) {
      this.logger.warn(
        `Ignoring projects_v2_item ${action} for locked project ${project.id}`,
      );
      await auditIgnoredLockedWebhook(this.prisma, project, sender, {
        event: 'projects_v2_item',
        action,
        projectNodeId,
        itemNodeId: projects_v2_item.node_id,
      });
      return;
    }

    switch (action) {
      case 'created':
        await this.handleCreated(project, projects_v2_item, sender);
        break;
      case 'edited':
        await this.handleEdited(
          project,
          {
            ...projects_v2_item,
            changes:
              payload.changes ??
              (
                projects_v2_item as GitHubProjectV2ItemPayload & {
                  changes?: GitHubProjectV2ItemEventPayload['changes'];
                }
              ).changes,
          },
          sender,
        );
        break;
      case 'deleted':
        await this.handleDeleted(project, projects_v2_item, sender);
        break;
      default:
        this.logger.debug(`Ignoring projects_v2_item action: ${action}`);
    }
  }

  /**
   * Handle new project item created → create task
   */
  private async handleCreated(
    project: Project,
    item: GitHubProjectV2ItemPayload,
    sender: GitHubUserPayload,
  ): Promise<void> {
    if (!item.content_node_id && !item.content?.number) {
      this.logger.debug(
        'Project item has no content node — skipping (draft item)',
      );
      return;
    }

    // Generate external task ID from the content node
    // For issues: TASK-<issue_number>, for now use node_id as fallback
    const externalTaskId = this.generateTaskId(item);

    // Check if task already exists
    const existing = await this.prisma.task.findUnique({
      where: {
        projectId_externalTaskId: {
          projectId: project.id,
          externalTaskId,
        },
      },
    });

    if (existing) {
      this.logger.debug(
        `Task ${externalTaskId} already exists — skipping creation`,
      );
      return;
    }

    const assignee = await this.resolveTaskAssignee(item);

    if (assignee) {
      await this.ensureProjectMembership(project.id, assignee.id);
    }

    await this.prisma.task.create({
      data: {
        projectId: project.id,
        externalTaskId,
        title: item.content?.title ?? `Task ${externalTaskId}`,
        assigneeId: assignee?.id ?? null,
        status: 'TODO',
        difficulty: 'MEDIUM',
      },
    });

    this.logger.log(
      `Task ${externalTaskId} created for project ${project.id}${assignee ? '' : ' without assignee'}`,
    );
    this.emitProjectUpdated(project.id);
  }

  /**
   * Handle project item edited → sync field changes
   */
  private async handleEdited(
    project: Project,
    item: GitHubProjectV2ItemPayload & {
      changes?: GitHubProjectV2ItemEventPayload['changes'];
    },
    sender: GitHubUserPayload,
  ): Promise<void> {
    const externalTaskId = this.generateTaskId(item);

    const task = await this.prisma.task.findUnique({
      where: {
        projectId_externalTaskId: {
          projectId: project.id,
          externalTaskId,
        },
      },
      include: {
        assignee: { select: safeUserSelect },
        pullRequests: true,
      },
    });

    if (!task) {
      this.logger.warn(
        `Task ${externalTaskId} not found for edit event — skipping`,
      );
      return;
    }

    // Check for field value changes in the payload
    const changes = item.changes;
    if (!changes) {
      this.logger.debug('No changes detected in edit event');
      return;
    }

    let mutated = false;

    // Handle status field change
    if (changes.field_value?.field_name === 'Status') {
      const newStatus = this.mapStatus(changes.field_value.to?.name);
      if (newStatus && newStatus !== task.status) {
        await this.prisma.task.update({
          where: { id: task.id },
          data: { status: newStatus },
        });
        mutated = true;
        const actor = await this.findOrCreateUser(
          String(sender.id),
          sender.login,
          sender.avatar_url,
        );
        await this.prisma.auditLog.create({
          data: {
            action: AuditAction.TASK_REASSIGN,
            actorId: actor.id,
            projectId: project.id,
            metadata: {
              type: 'TASK_STATUS_CHANGE',
              taskId: externalTaskId,
              previousStatus: task.status,
              newStatus,
              source: 'GITHUB_PROJECT',
            },
          },
        });
        if (
          newStatus === 'DONE' &&
          !task.pullRequests.some((pr) => pr.status === 'MERGED')
        ) {
          this.logger.warn(
            `Task ${externalTaskId} moved to Done without a merged PR - no score awarded`,
          );
        }
        this.logger.log(
          `Task ${externalTaskId} status updated: ${task.status} → ${newStatus}`,
        );
      }
    }

    // Handle assignee field change
    if (changes.field_value?.field_name === 'Assignees') {
      const assignee = await this.resolveTaskAssignee(item);
      const newAssigneeId = assignee?.id ?? null;

      if (newAssigneeId !== task.assigneeId) {
        const previousAssigneeId = task.assigneeId;
        const previousAssigneeName = task.assignee?.name ?? 'Unassigned';
        const newAssigneeName =
          assignee?.name ?? assignee?.githubUsername ?? 'Unassigned';
        const actor = await this.findOrCreateUser(
          String(sender.id),
          sender.login,
          sender.avatar_url,
        );

        if (assignee) {
          await this.ensureProjectMembership(project.id, assignee.id);
        }

        await this.prisma.task.update({
          where: { id: task.id },
          data: { assigneeId: newAssigneeId },
        });
        mutated = true;

        // Log to audit_logs (spec §8 strict rules)
        await this.prisma.auditLog.create({
          data: {
            action: AuditAction.TASK_REASSIGN,
            actorId: actor.id,
            projectId: project.id,
            metadata: {
              type: 'TASK_ASSIGNEE_CHANGE',
              taskId: externalTaskId,
              previousAssigneeId,
              newAssigneeId,
              hasOpenPRs: task.pullRequests.some((pr) => pr.status === 'OPEN'),
            },
          },
        });

        // FLAG if task has open PRs (reassignment after PR opened)
        if (task.pullRequests.some((pr) => pr.status === 'OPEN')) {
          this.logger.warn(
            `FLAG: Task ${externalTaskId} reassigned while having open PRs`,
          );
        }

        this.logger.log(
          `Task ${externalTaskId} assignee changed: ${previousAssigneeName} → ${newAssigneeName}`,
        );
      }
    }

    if (mutated) {
      this.emitProjectUpdated(project.id);
    }
  }

  /**
   * Handle project item deleted → soft-delete task
   */
  private async handleDeleted(
    project: Project,
    item: GitHubProjectV2ItemPayload,
    sender: GitHubUserPayload,
  ): Promise<void> {
    const externalTaskId = this.generateTaskId(item);

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
        `Task ${externalTaskId} not found for deletion — already removed`,
      );
      return;
    }

    // Soft-delete: set status to BLOCKED (spec §13: task deleted on GitHub → soft-delete + flag)
    await this.prisma.task.update({
      where: { id: task.id },
      data: { status: 'BLOCKED' },
    });

    const actor = await this.findOrCreateUser(
      String(sender.id),
      sender.login,
      sender.avatar_url,
    );
    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.TASK_REASSIGN,
        actorId: actor.id,
        projectId: project.id,
        metadata: {
          type: 'TASK_SOFT_DELETE',
          taskId: externalTaskId,
          previousStatus: task.status,
          newStatus: 'BLOCKED',
          source: 'GITHUB_PROJECT_ITEM_DELETED',
        },
      },
    });

    this.logger.warn(
      `Task ${externalTaskId} soft-deleted (set to BLOCKED) — item removed from GitHub Project`,
    );
    this.emitProjectUpdated(project.id);
  }

  /**
   * Generate a Lime++ task ID from a projects_v2_item
   *
   * Uses content_node_id as a stable identifier.
   * When the content is an Issue, we'll use TASK-<node_id_hash> format.
   */
  private generateTaskId(item: GitHubProjectV2ItemPayload): string {
    if (item.content?.number) {
      return `TASK-${item.content.number}`;
    }

    // Use the content_node_id if available, otherwise use node_id
    const nodeId = item.content_node_id ?? item.node_id;
    // Create a short, deterministic ID from the node
    return `TASK-${nodeId}`;
  }

  /**
   * Map GitHub Project status field values to our TaskStatus enum
   */
  private mapStatus(
    statusName: string | undefined,
  ): 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' | null {
    if (!statusName) return null;

    switch (statusName.toLowerCase()) {
      case 'todo':
      case 'to do':
      case 'backlog':
        return 'TODO';
      case 'in progress':
      case 'in_progress':
      case 'doing':
        return 'IN_PROGRESS';
      case 'done':
      case 'completed':
      case 'closed':
        return 'DONE';
      case 'blocked':
        return 'BLOCKED';
      default:
        return null;
    }
  }

  /**
   * Find a user by GitHub user ID, or auto-create a minimal record
   */
  private async findOrCreateUser(
    githubUserId: string,
    login: string,
    avatarUrl?: string,
  ) {
    return findOrCreateGitHubUser(this.prisma, {
      githubUserId,
      login,
      avatarUrl,
    });
  }

  private async resolveTaskAssignee(
    item: GitHubProjectV2ItemPayload,
    fallback?: GitHubUserPayload,
  ) {
    const assignedUser = item.content?.assignees?.nodes[0] ?? fallback;
    if (!assignedUser) return null;

    return this.findOrCreateUser(
      String(assignedUser.id),
      assignedUser.login,
      assignedUser.avatar_url,
    );
  }

  private async ensureProjectMembership(projectId: string, userId: string) {
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
      },
    });
  }
}
