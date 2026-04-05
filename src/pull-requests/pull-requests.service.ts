import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PrStatus } from '../generated/prisma/enums';

@Injectable()
export class PullRequestsService {
  constructor(private prisma: PrismaService) {}

  async findAll(projectId: string, assigneeId?: string, status?: string) {
    return this.prisma.pullRequest.findMany({
      where: {
        projectId,
        authorId: assigneeId || undefined,
        status: status as any || undefined,
      },
      include: {
        author: true,
        task: true,
        reviews: { include: { reviewer: true } },
      },
    });
  }

  async findOne(id: string) {
    const pr = await this.prisma.pullRequest.findUnique({
      where: { id },
      include: { project: true, author: true, task: true, reviews: true },
    });
    if (!pr) throw new NotFoundException('Pull Request not found');
    return pr;
  }

  // Manual re-validation could be complex, but for MVP it just returns the current state
  async validateLink(id: string) {
    const pr = await this.findOne(id);
    const task = pr.task;
    return {
      valid: !!pr.taskId && !!task,
      task_id: task ? task.externalTaskId : null,
      merged: pr.status === PrStatus.MERGED,
      author_login: pr.author.githubUserId,
      assignee_match: task ? (task.assigneeId === pr.authorId) : null,
    };
  }
}
