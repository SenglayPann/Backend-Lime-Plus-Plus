import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, TaskStatus } from '../generated/prisma';
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

    return this.prisma.task.update({
      where: { id },
      data: { assigneeId },
    });
  }
}
