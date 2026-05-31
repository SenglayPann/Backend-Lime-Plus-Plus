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
  PROJECT_LEAD: 1.5,
  PROJECT_MEMBER: 1,
  ORGANIZATION_MEMBER: 0,
};

@Injectable()
export class RoleDelegationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertTargetCanBeManaged(
    actorId: string,
    actorRoles: Role[],
    targetUserId: string,
  ) {
    await this.assertTargetIsNotProtected(actorId, actorRoles, targetUserId);
  }

  /**
   * Idempotently ensure the user has an ORGANIZATION_MEMBER role for the
   * given organization. Any scoped role assignment (PROJECT_MANAGER on a
   * project in org X, DEPARTMENT_MANAGER in a department of org X, etc.)
   * implies the user is part of org X — modeling it explicitly keeps the
   * org member list, project member list, and Users & Roles view
   * consistent. Returns true if a row was newly created.
   */
  async ensureOrganizationMembership(
    userId: string,
    organizationId: string | null | undefined,
    actorId: string,
  ): Promise<boolean> {
    if (!organizationId) return false;

    const existing = await this.prisma.userRole.findFirst({
      where: {
        userId,
        organizationId,
        role: PrismaRole.ORGANIZATION_MEMBER,
      },
      select: { id: true },
    });
    if (existing) return false;

    await this.prisma.userRole.create({
      data: {
        userId,
        role: PrismaRole.ORGANIZATION_MEMBER,
        organizationId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.ROLE_CHANGE,
        actorId,
        metadata: {
          operation: 'auto_grant_member',
          targetUserId: userId,
          role: PrismaRole.ORGANIZATION_MEMBER,
          organizationId,
          reason: 'Implicit grant from scoped role assignment',
        },
      },
    });

    return true;
  }

  /**
   * Look up the organization a department belongs to. Used by callers
   * that need to fold a department- or project-scoped role assignment
   * back into an org membership.
   */
  async resolveDepartmentOrganization(departmentId: string): Promise<string | null> {
    const dept = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { organizationId: true },
    });
    return dept?.organizationId ?? null;
  }

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

    // Roll up org membership for any scoped role that lives inside an
    // organization. ORGANIZATION_MEMBER is the role itself — no rollup.
    // ADMIN has no scope, also nothing to roll up.
    if (
      role !== PrismaRole.ADMIN &&
      role !== PrismaRole.ORGANIZATION_MEMBER
    ) {
      const orgIdForMembership =
        organizationId ||
        (departmentId
          ? await this.resolveDepartmentOrganization(departmentId)
          : null);
      await this.ensureOrganizationMembership(
        targetUserId,
        orgIdForMembership,
        actorId,
      );
    }

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

    // Orphan-prevention invariants. Applied AFTER the authorization check
    // and BEFORE the delete, regardless of actor (including ADMIN). The
    // intent is to keep the system, an organization, or a department from
    // becoming un-manageable through normal API operations. If a genuine
    // emergency truly requires removing the last admin/manager, do it via
    // a DB migration with an audit trail.
    await this.assertRemovalPreservesInvariants(role);

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

    if (role === PrismaRole.PROJECT_MANAGER) {
      await this.assertActorManagesDepartment(
        actorId,
        actorRoles,
        departmentId!,
      );
      return;
    }

    if (role === PrismaRole.ORGANIZATION_MEMBER) {
      await this.assertActorManagesOrganization(
        actorId,
        actorRoles,
        organizationId!,
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

    if (role.role === PrismaRole.PROJECT_MANAGER && role.departmentId) {
      await this.assertActorManagesDepartment(
        actorId,
        actorRoles,
        role.departmentId,
      );
      return;
    }

    if (role.role === PrismaRole.ORGANIZATION_MEMBER && role.organizationId) {
      await this.assertActorManagesOrganization(
        actorId,
        actorRoles,
        role.organizationId,
      );
      return;
    }

    throw new ForbiddenException('You cannot remove this role');
  }

  private assertRoleUsesUserRoles(role: PrismaRole) {
    if (
      role === PrismaRole.PROJECT_MEMBER ||
      role === PrismaRole.PROJECT_LEAD
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

    if (role === PrismaRole.ORGANIZATION_MEMBER && !organizationId) {
      throw new BadRequestException(
        'Organization Member requires organization_id',
      );
    }

    if (role === PrismaRole.ORGANIZATION_MEMBER && departmentId) {
      throw new BadRequestException(
        'Organization Member cannot have department_id',
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

    if (role === PrismaRole.PROJECT_MANAGER && !departmentId) {
      throw new BadRequestException(
        'Project Manager supervisor requires department_id scope',
      );
    }
  }

  private async assertActorManagesDepartment(
    actorId: string,
    actorRoles: Role[],
    departmentId: string,
  ) {
    if (actorRoles.includes('ORGANIZATION_MANAGER')) {
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
      return;
    }

    if (actorRoles.includes('DEPARTMENT_MANAGER')) {
      const actorRole = await this.prisma.userRole.findFirst({
        where: {
          userId: actorId,
          role: PrismaRole.DEPARTMENT_MANAGER,
          departmentId,
        },
      });
      if (!actorRole) {
        throw new ForbiddenException(
          'You are not a department manager for this department',
        );
      }
      return;
    }

    throw new ForbiddenException(
      'Only department managers or organization managers can manage project managers',
    );
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

  private async assertActorManagesOrganization(
    actorId: string,
    actorRoles: Role[],
    organizationId: string,
  ) {
    if (!actorRoles.includes('ORGANIZATION_MANAGER')) {
      throw new ForbiddenException(
        'Only organization managers can manage organization members',
      );
    }

    const orgRole = await this.prisma.userRole.findFirst({
      where: {
        userId: actorId,
        role: PrismaRole.ORGANIZATION_MANAGER,
        organizationId,
      },
      select: { id: true },
    });

    if (!orgRole) {
      throw new ForbiddenException(
        'You do not manage the selected organization',
      );
    }
  }

  private async assertRemovalPreservesInvariants(role: {
    id: string;
    role: PrismaRole;
    organizationId: string | null;
    departmentId: string | null;
  }) {
    if (role.role === PrismaRole.ADMIN) {
      await this.assertSystemKeepsAnotherAdmin(role.id);
      return;
    }
    if (role.role === PrismaRole.ORGANIZATION_MANAGER && role.organizationId) {
      await this.assertOrgKeepsAnotherManager(role.organizationId, role.id);
      return;
    }
    if (role.role === PrismaRole.DEPARTMENT_MANAGER && role.departmentId) {
      await this.assertDeptKeepsAnotherManager(role.departmentId, role.id);
      return;
    }
  }

  private async assertSystemKeepsAnotherAdmin(excludedRoleId: string) {
    const remaining = await this.prisma.userRole.count({
      where: {
        role: PrismaRole.ADMIN,
        id: { not: excludedRoleId },
      },
    });
    if (remaining === 0) {
      throw new ConflictException(
        'System must keep at least one administrator',
      );
    }
  }

  private async assertOrgKeepsAnotherManager(
    organizationId: string,
    excludedRoleId: string,
  ) {
    const remaining = await this.prisma.userRole.count({
      where: {
        organizationId,
        role: PrismaRole.ORGANIZATION_MANAGER,
        id: { not: excludedRoleId },
      },
    });
    if (remaining === 0) {
      throw new ConflictException(
        'Organization must keep at least one organization manager',
      );
    }
  }

  private async assertDeptKeepsAnotherManager(
    departmentId: string,
    excludedRoleId: string,
  ) {
    const remaining = await this.prisma.userRole.count({
      where: {
        departmentId,
        role: PrismaRole.DEPARTMENT_MANAGER,
        id: { not: excludedRoleId },
      },
    });
    if (remaining === 0) {
      throw new ConflictException(
        'Department must keep at least one department manager',
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

  async getTargetEffectiveRoles(userId: string): Promise<Role[]> {
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
