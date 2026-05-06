import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AssignTaskDto } from './dto/assign-task.dto';
import { TaskStatus } from '../generated/prisma';

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  async findAll(projectId?: string, assigneeId?: string, status?: string) {
    return this.prisma.task.findMany({
      where: {
        projectId: projectId || undefined,
        assigneeId: assigneeId || undefined,
        status: status as any || undefined,
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

  async assignTask(id: string, assigneeId: string) {
    const task = await this.findOne(id);
    
    return this.prisma.task.update({
      where: { id },
      data: { assigneeId },
    });
  }
}
