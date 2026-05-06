import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async findAll(projectId?: string, actorId?: string, action?: string) {
    return this.prisma.auditLog.findMany({
      where: {
        projectId: projectId || undefined,
        actorId: actorId || undefined,
        action: (action as any) || undefined,
      },
      include: {
        actor: true,
        project: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
