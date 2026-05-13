import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Role as PrismaRole } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
import type { Role } from '../decorators/roles.decorator';

const ROLE_RANK: Record<Role, number> = {
  ADMIN: 5,
  ORGANIZATION_MANAGER: 4,
  DEPARTMENT_MANAGER: 3,
  PROJECT_MANAGER: 2,
  PROJECT_MEMBER: 1,
};

@Injectable()
export class RoleDelegationService {
  constructor(private readonly prisma: PrismaService) {}

  async assignUserRole(
    actorId: string,
    actorRoles: Role[],
    targetUserId: string,
    role: PrismaRole,
    organizationId?: string,
    departmentId?: string,
  ) {
    this.assertRoleUsesUserRoles(role);
    await this.assertCanAssignUserRole(
      actorId,
      actorRoles,
      targetUserId,
      role,
      organizationId,
      departmentId,
    );

    const existing = await this.prisma.userRole.findFirst({
      where: {
        userId: targetUserId,
        role,
        organizationId: organizationId || null,
        departmentId: departmentId || null,
      },
    });

    if (existing) {
      throw new ConflictException('User already has this role in this scope');
    }

    const created = await this.prisma.userRole.create({
      data: {
        userId: targetUserId,
        role,
        organizationId,
        departmentId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.ROLE_CHANGE,
        actorId,
        metadata: {
          operation: 'assign',
          targetUserId,
          role,
          organizationId,
          departmentId,
        },
      },
    });

    return created;
  }

  async removeUserRole(actorId: string, actorRoles: Role[], roleId: string) {
    const role = await this.prisma.userRole.findUnique({
      where: { id: roleId },
    });

    if (!role) {
      throw new NotFoundException('Role assignment not found');
    }

    await this.assertCanRemoveUserRole(actorId, actorRoles, role);

    const removed = await this.prisma.userRole.delete({
      where: { id: roleId },
    });

    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.ROLE_CHANGE,
        actorId,
        metadata: {
          operation: 'remove',
          targetUserId: role.userId,
          role: role.role,
          organizationId: role.organizationId,
          departmentId: role.departmentId,
        },
      },
    });

    return removed;
  }

  private async assertCanAssignUserRole(
    actorId: string,
    actorRoles: Role[],
    targetUserId: string,
    role: PrismaRole,
    organizationId?: string,
    departmentId?: string,
  ) {
    await this.assertTargetIsNotProtected(actorId, actorRoles, targetUserId);
    this.assertRequiredScope(role, organizationId, departmentId);

    if (actorRoles.includes('ADMIN')) {
      return;
    }

    const actorRank = this.highestRank(actorRoles);
    if (ROLE_RANK[role] >= actorRank) {
      throw new ForbiddenException(
        'You cannot assign a role equal to or higher than your role',
      );
    }

    if (role === PrismaRole.DEPARTMENT_MANAGER) {
      await this.assertActorManagesDepartmentOrganization(
        actorId,
        actorRoles,
        departmentId!,
      );
      return;
    }

    throw new ForbiddenException('You cannot assign this role');
  }

  private async assertCanRemoveUserRole(
    actorId: string,
    actorRoles: Role[],
    role: {
      userId: string;
      role: PrismaRole;
      organizationId: string | null;
      departmentId: string | null;
    },
  ) {
    await this.assertTargetIsNotProtected(actorId, actorRoles, role.userId);

    if (actorRoles.includes('ADMIN')) {
      return;
    }

    const actorRank = this.highestRank(actorRoles);
    if (ROLE_RANK[role.role] >= actorRank) {
      throw new ForbiddenException(
        'You cannot remove a role equal to or higher than your role',
      );
    }

    if (role.role === PrismaRole.DEPARTMENT_MANAGER && role.departmentId) {
      await this.assertActorManagesDepartmentOrganization(
        actorId,
        actorRoles,
        role.departmentId,
      );
      return;
    }

    throw new ForbiddenException('You cannot remove this role');
  }

  private assertRoleUsesUserRoles(role: PrismaRole) {
    if (
      role === PrismaRole.PROJECT_MANAGER ||
      role === PrismaRole.PROJECT_MEMBER
    ) {
      throw new BadRequestException(
        'Project roles must be managed through project membership',
      );
    }
  }

  private assertRequiredScope(
    role: PrismaRole,
    organizationId?: string,
    departmentId?: string,
  ) {
    if (role === PrismaRole.ADMIN) {
      if (organizationId || departmentId) {
        throw new BadRequestException('Admin role cannot have a scope');
      }
      return;
    }

    if (role === PrismaRole.ORGANIZATION_MANAGER && !organizationId) {
      throw new BadRequestException(
        'Organization Manager requires organization_id',
      );
    }

    if (role === PrismaRole.ORGANIZATION_MANAGER && departmentId) {
      throw new BadRequestException(
        'Organization Manager cannot have department_id',
      );
    }

    if (role === PrismaRole.DEPARTMENT_MANAGER && !departmentId) {
      throw new BadRequestException(
        'Department Manager requires department_id',
      );
    }

    if (role === PrismaRole.DEPARTMENT_MANAGER && organizationId) {
      throw new BadRequestException(
        'Department Manager cannot have organization_id',
      );
    }
  }

  private async assertActorManagesDepartmentOrganization(
    actorId: string,
    actorRoles: Role[],
    departmentId: string,
  ) {
    if (!actorRoles.includes('ORGANIZATION_MANAGER')) {
      throw new ForbiddenException(
        'Only organization managers can assign department managers',
      );
    }

    const department = await this.prisma.department.findFirst({
      where: {
        id: departmentId,
        organization: {
          userRoles: {
            some: {
              userId: actorId,
              role: PrismaRole.ORGANIZATION_MANAGER,
            },
          },
        },
      },
      select: { id: true },
    });

    if (!department) {
      throw new ForbiddenException(
        'You do not manage the selected department organization',
      );
    }
  }

  private async assertTargetIsNotProtected(
    actorId: string,
    actorRoles: Role[],
    targetUserId: string,
  ) {
    if (actorRoles.includes('ADMIN') || actorId === targetUserId) {
      return;
    }

    const targetRoles = await this.getTargetEffectiveRoles(targetUserId);
    const actorRank = this.highestRank(actorRoles);
    const targetRank = this.highestRank(targetRoles);

    if (targetRank >= actorRank) {
      throw new ForbiddenException(
        'You cannot change roles for an equal or higher level user',
      );
    }
  }

  private async getTargetEffectiveRoles(userId: string): Promise<Role[]> {
    const [userRoles, projectRoles] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId },
        select: { role: true },
      }),
      this.prisma.projectMember.findMany({
        where: { userId },
        select: { role: true },
      }),
    ]);

    return Array.from(
      new Set([
        ...userRoles.map((entry) => entry.role as Role),
        ...projectRoles.map((entry) => entry.role as Role),
      ]),
    );
  }

  private highestRank(roles: Role[]) {
    return Math.max(0, ...roles.map((role) => ROLE_RANK[role] || 0));
  }
}
