import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditAction,
  Prisma,
  TaskDifficulty,
  TaskStatus,
} from '../generated/prisma';
import { ProjectAccessService } from '../common/access/project-access.service';
import { ProjectLockGuardService } from '../common/access/project-lock-guard.service';
import { safeUserSelect } from '../common/serialization/safe-user-select';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
    private projectLockGuard: ProjectLockGuardService,
    private eventEmitter: EventEmitter2,
  ) {}

  async findAll(
    actorId: string,
    actorRoles: Role[],
    projectId?: string,
    assigneeId?: string,
    status?: string,
  ) {
    const statusFilter = (status as TaskStatus) || undefined;

    if (projectId) {
      await this.projectAccessService.assertCanViewProject(
        actorId,
        actorRoles,
        projectId,
      );

      const canManageProject = await this.projectAccessService.canManageProject(
        actorId,
        actorRoles,
        projectId,
      );

      if (!canManageProject && assigneeId && assigneeId !== actorId) {
        return [];
      }

      return this.prisma.task.findMany({
        where: {
          projectId,
          assigneeId: canManageProject ? assigneeId || undefined : actorId,
          status: statusFilter,
        },
        include: {
          project: true,
          assignee: { select: safeUserSelect },
          pullRequests: true,
        },
      });
    }

    const [accessibleProjectIds, manageableProjectIds] = await Promise.all([
      this.projectAccessService.getAccessibleProjectIds(actorId, actorRoles),
      this.projectAccessService.getManageableProjectIds(actorId, actorRoles),
    ]);

    if (accessibleProjectIds.length === 0) {
      return [];
    }

    const manageableProjectIdSet = new Set(manageableProjectIds);
    const ownOnlyProjectIds = accessibleProjectIds.filter(
      (id) => !manageableProjectIdSet.has(id),
    );
    const scopedClauses: Prisma.TaskWhereInput[] = [];

    if (manageableProjectIds.length > 0) {
      scopedClauses.push({
        projectId: { in: manageableProjectIds },
        assigneeId: assigneeId || undefined,
      });
    }

    if (
      ownOnlyProjectIds.length > 0 &&
      (!assigneeId || assigneeId === actorId)
    ) {
      scopedClauses.push({
        projectId: { in: ownOnlyProjectIds },
        assigneeId: actorId,
      });
    }

    if (scopedClauses.length === 0) {
      return [];
    }

    const projectScope =
      scopedClauses.length === 1 ? scopedClauses[0] : { OR: scopedClauses };

    return this.prisma.task.findMany({
      where: {
        ...projectScope,
        status: statusFilter,
      },
      include: {
        project: true,
        assignee: { select: safeUserSelect },
        pullRequests: true,
      },
    });
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        project: true,
        assignee: { select: safeUserSelect },
        pullRequests: true,
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  /**
   * Update Lime++-owned task fields (difficulty, due date).
   *
   * These are stored in Lime++ rather than synced from a GitHub Projects v2
   * custom field — the teacher edits them in the Lime++ UI. Editing
   * triggers a project-wide score recalculation so any already-completed
   * task using this difficulty/due-date will reflect the new modifiers
   * immediately.
   */
  async updateTask(
    id: string,
    fields: {
      difficulty?: TaskDifficulty;
      dueDate?: Date | null;
    },
    actorId: string,
    actorRoles: Role[],
  ) {
    const task = await this.findOne(id);
    await this.projectLockGuard.assertProjectMutable(task.projectId, 'edit tasks');
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      task.projectId,
    );

    const updateData: Prisma.TaskUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (fields.difficulty !== undefined && fields.difficulty !== task.difficulty) {
      updateData.difficulty = fields.difficulty;
      changes.difficulty = { from: task.difficulty, to: fields.difficulty };
    }

    if (fields.dueDate !== undefined) {
      const next = fields.dueDate ? new Date(fields.dueDate) : null;
      const current = task.dueDate ? new Date(task.dueDate).toISOString() : null;
      const nextIso = next ? next.toISOString() : null;
      if (current !== nextIso) {
        updateData.dueDate = next;
        changes.dueDate = { from: current, to: nextIso };
      }
    }

    if (Object.keys(updateData).length === 0) {
      // No-op: returning the task unchanged is friendlier than throwing.
      return task;
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data: updateData,
      include: {
        project: true,
        assignee: { select: safeUserSelect },
        pullRequests: true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.TASK_REASSIGN,
        actorId,
        projectId: task.projectId,
        metadata: {
          type: 'TASK_FIELDS_UPDATED',
          taskId: task.externalTaskId ?? task.id,
          changes,
        } as Prisma.InputJsonValue,
      },
    });

    // Difficulty and due date are scoring inputs; trigger a recalc.
    // Reusing contribution.created keeps the wiring identical to how
    // PR-merge and PR-review handlers already trigger scoring.
    this.eventEmitter.emit('contribution.created', {
      projectId: task.projectId,
    });

    return updated;
  }

  async assignTask(
    id: string,
    assigneeId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    const task = await this.findOne(id);
    await this.projectLockGuard.assertProjectMutable(
      task.projectId,
      'assign tasks',
    );
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      task.projectId,
    );

    const assigneeMembership = await this.prisma.projectMember.findFirst({
      where: {
        projectId: task.projectId,
        userId: assigneeId,
      },
      select: { id: true },
    });

    if (!assigneeMembership) {
      throw new BadRequestException('Assignee must be a member of the project');
    }

    const updatedTask = await this.prisma.task.update({
      where: { id },
      data: { assigneeId },
    });

    if (task.assigneeId !== assigneeId) {
      await this.prisma.auditLog.create({
        data: {
          action: AuditAction.TASK_REASSIGN,
          actorId,
          projectId: task.projectId,
          metadata: {
            type: 'MANUAL_TASK_REASSIGN',
            taskId: task.externalTaskId ?? task.id,
            previousAssigneeId: task.assigneeId,
            newAssigneeId: assigneeId,
            hasOpenPRs:
              task.pullRequests?.some((pr) => pr.status === 'OPEN') ?? false,
          },
        },
      });
    }

    return updatedTask;
  }
}
