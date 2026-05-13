import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PrStatus } from '../generated/prisma';
import { ProjectAccessService } from '../common/access/project-access.service';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class PullRequestsService {
  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
  ) {}

  async findAll(
    actorId: string,
    actorRoles: Role[],
    projectId: string,
    assigneeId?: string,
    status?: string,
  ) {
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

    return this.prisma.pullRequest.findMany({
      where: {
        projectId,
        authorId: canManageProject ? assigneeId || undefined : actorId,
        status: (status as PrStatus) || undefined,
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
  async validateLink(id: string, actorId: string, actorRoles: Role[]) {
    const pr = await this.findOne(id);
    await this.projectAccessService.assertCanViewProject(
      actorId,
      actorRoles,
      pr.projectId,
    );
    const canManageProject = await this.projectAccessService.canManageProject(
      actorId,
      actorRoles,
      pr.projectId,
    );

    if (!canManageProject && pr.authorId !== actorId) {
      throw new ForbiddenException(
        'You do not have permission to validate this pull request',
      );
    }

    const task = pr.task;
    return {
      valid: !!pr.taskId && !!task,
      task_id: task ? task.externalTaskId : null,
      merged: pr.status === PrStatus.MERGED,
      author_login: pr.author.githubUserId,
      assignee_match: task ? task.assigneeId === pr.authorId : null,
    };
  }
}
