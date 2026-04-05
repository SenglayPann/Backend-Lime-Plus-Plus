import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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

  constructor(private prisma: PrismaService) {}

  /**
   * Main entry point for projects_v2_item webhook events
   */
  async handle(payload: any): Promise<void> {
    const { action, projects_v2_item, sender } = payload;

    if (!projects_v2_item) {
      this.logger.warn('Invalid projects_v2_item payload: missing required fields');
      return;
    }

    this.logger.log(`Project item ${action}: node_id=${projects_v2_item.node_id}`);

    // Find the project by external project ID
    const projectNodeId = projects_v2_item.project_node_id;
    const project = await this.prisma.project.findFirst({
      where: { externalProjectId: projectNodeId },
    });

    if (!project) {
      this.logger.warn(`No project found for GitHub Project node ${projectNodeId}`);
      return;
    }

    switch (action) {
      case 'created':
        await this.handleCreated(project, projects_v2_item, sender);
        break;
      case 'edited':
        await this.handleEdited(project, projects_v2_item, sender);
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
    project: any,
    item: any,
    sender: any,
  ): Promise<void> {
    const contentNodeId = item.content_node_id;
    if (!contentNodeId) {
      this.logger.debug('Project item has no content node — skipping (draft item)');
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
      this.logger.debug(`Task ${externalTaskId} already exists — skipping creation`);
      return;
    }

    // Find or create the sender as the initial assignee
    // (actual assignee will be synced when the field changes)
    const actor = sender
      ? await this.findOrCreateUser(String(sender.id), sender.login, sender.avatar_url)
      : null;

    if (!actor) {
      this.logger.warn('Cannot create task: no sender information available');
      return;
    }

    await this.prisma.task.create({
      data: {
        projectId: project.id,
        externalTaskId,
        title: `Task ${externalTaskId}`,
        assigneeId: actor.id,
        status: 'TODO',
        difficulty: 'MEDIUM',
      },
    });

    this.logger.log(`Task ${externalTaskId} created for project ${project.id}`);
  }

  /**
   * Handle project item edited → sync field changes
   */
  private async handleEdited(
    project: any,
    item: any,
    sender: any,
  ): Promise<void> {
    const externalTaskId = this.generateTaskId(item);

    const task = await this.prisma.task.findUnique({
      where: {
        projectId_externalTaskId: {
          projectId: project.id,
          externalTaskId,
        },
      },
      include: { assignee: true, pullRequests: true },
    });

    if (!task) {
      this.logger.warn(`Task ${externalTaskId} not found for edit event — skipping`);
      return;
    }

    // Check for field value changes in the payload
    const changes = item.changes;
    if (!changes) {
      this.logger.debug('No changes detected in edit event');
      return;
    }

    // Handle status field change
    if (changes.field_value?.field_name === 'Status') {
      const newStatus = this.mapStatus(changes.field_value.to?.name);
      if (newStatus && newStatus !== task.status) {
        await this.prisma.task.update({
          where: { id: task.id },
          data: { status: newStatus },
        });
        this.logger.log(`Task ${externalTaskId} status updated: ${task.status} → ${newStatus}`);
      }
    }

    // Handle assignee field change
    if (changes.field_value?.field_name === 'Assignees') {
      const actor = sender
        ? await this.findOrCreateUser(String(sender.id), sender.login, sender.avatar_url)
        : null;

      if (actor && actor.id !== task.assigneeId) {
        const previousAssigneeId = task.assigneeId;

        await this.prisma.task.update({
          where: { id: task.id },
          data: { assigneeId: actor.id },
        });

        // Log to audit_logs (spec §8 strict rules)
        await this.prisma.auditLog.create({
          data: {
            action: 'TASK_REASSIGN',
            actorId: actor.id,
            projectId: project.id,
            metadata: {
              taskId: externalTaskId,
              previousAssigneeId,
              newAssigneeId: actor.id,
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
          `Task ${externalTaskId} assignee changed: ${task.assignee.name} → ${actor.name ?? sender.login}`,
        );
      }
    }
  }

  /**
   * Handle project item deleted → soft-delete task
   */
  private async handleDeleted(
    project: any,
    item: any,
    sender: any,
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
      this.logger.debug(`Task ${externalTaskId} not found for deletion — already removed`);
      return;
    }

    // Soft-delete: set status to BLOCKED (spec §13: task deleted on GitHub → soft-delete + flag)
    await this.prisma.task.update({
      where: { id: task.id },
      data: { status: 'BLOCKED' },
    });

    this.logger.warn(`Task ${externalTaskId} soft-deleted (set to BLOCKED) — item removed from GitHub Project`);
  }

  /**
   * Generate a Lime++ task ID from a projects_v2_item
   *
   * Uses content_node_id as a stable identifier.
   * When the content is an Issue, we'll use TASK-<node_id_hash> format.
   */
  private generateTaskId(item: any): string {
    // Use the content_node_id if available, otherwise use node_id
    const nodeId = item.content_node_id ?? item.node_id;
    // Create a short, deterministic ID from the node
    return `TASK-${nodeId}`;
  }

  /**
   * Map GitHub Project status field values to our TaskStatus enum
   */
  private mapStatus(statusName: string | undefined): 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED' | null {
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
