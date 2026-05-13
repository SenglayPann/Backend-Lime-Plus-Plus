import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '../../generated/prisma';
import { ProjectAccessService } from '../access/project-access.service';
import type { Role } from '../decorators/roles.decorator';

@Injectable()
export class AuditService {
  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
  ) {}

  async findAll(
    viewerId: string,
    viewerRoles: Role[],
    projectId?: string,
    actorId?: string,
    action?: AuditAction,
  ) {
    if (!viewerRoles.includes('ADMIN')) {
      if (!projectId) {
        return [];
      }

      await this.projectAccessService.assertCanManageProject(
        viewerId,
        viewerRoles,
        projectId,
      );
    }

    return this.prisma.auditLog.findMany({
      where: {
        projectId: projectId || undefined,
        actorId: actorId || undefined,
        action: action || undefined,
      },
      include: {
        actor: true,
        project: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
