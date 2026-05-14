import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type LockableProject = {
  id: string;
  status: string;
};

@Injectable()
export class ProjectLockGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async assertProjectMutable(
    projectId: string,
    action = 'modify this project',
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, status: true },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    this.assertMutable(project, action);
  }

  assertMutable(project: LockableProject, action = 'modify this project'): void {
    if (this.isLocked(project)) {
      throw new ConflictException(`Cannot ${action} after project lock`);
    }
  }

  isLocked(project: LockableProject): boolean {
    return project.status === 'LOCKED';
  }
}
