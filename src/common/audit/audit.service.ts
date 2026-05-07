import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '../../generated/prisma';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async findAll(projectId?: string, actorId?: string, action?: AuditAction) {
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
