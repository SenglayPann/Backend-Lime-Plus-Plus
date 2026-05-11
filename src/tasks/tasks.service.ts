import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TaskStatus } from '../generated/prisma';
import { ProjectAccessService } from '../common/access/project-access.service';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
  ) {}

  async findAll(
    actorId: string,
    actorRoles: Role[],
    projectId?: string,
    assigneeId?: string,
    status?: string,
  ) {
    let scopedProjectIds: string[] | undefined;

    if (projectId) {
      await this.projectAccessService.assertCanViewProject(
        actorId,
        actorRoles,
        projectId,
      );
      scopedProjectIds = [projectId];
    } else {
      scopedProjectIds = await this.projectAccessService.getAccessibleProjectIds(
        actorId,
        actorRoles,
      );
    }

    if (scopedProjectIds.length === 0) {
      return [];
    }

    return this.prisma.task.findMany({
      where: {
        projectId: { in: scopedProjectIds },
        assigneeId: assigneeId || undefined,
        status: (status as TaskStatus) || undefined,
      },
      include: {
        project: true,
        assignee: true,
        pullRequests: true,
      },
    });
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { project: true, assignee: true, pullRequests: true },
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
      throw new BadRequestException(
        'Assignee must be a member of the project',
      );
    }

    return this.prisma.task.update({
      where: { id },
      data: { assigneeId },
    });
  }
}
