import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role as PrismaRole } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
import type { Role } from '../decorators/roles.decorator';

@Injectable()
export class DepartmentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  buildAccessibleDepartmentWhere(
    userId: string,
    roles: Role[],
    organizationId?: string,
  ): Prisma.DepartmentWhereInput {
    if (roles.includes('ADMIN')) {
      return organizationId ? { organizationId } : {};
    }

    const clauses: Prisma.DepartmentWhereInput[] = [];

    if (roles.includes('ORGANIZATION_MANAGER')) {
      clauses.push({
        organization: {
          userRoles: {
            some: {
              userId,
              role: PrismaRole.ORGANIZATION_MANAGER,
            },
          },
        },
      });
    }

    if (roles.includes('DEPARTMENT_MANAGER')) {
      clauses.push({
        userRoles: {
          some: {
            userId,
            role: PrismaRole.DEPARTMENT_MANAGER,
          },
        },
      });
    }

    if (roles.includes('PROJECT_MANAGER')) {
      clauses.push({
        userRoles: {
          some: {
            userId,
            role: PrismaRole.PROJECT_MANAGER,
          },
        },
      });
    }

    if (this.hasAnyRole(roles, ['PROJECT_MANAGER', 'PROJECT_LEAD', 'PROJECT_MEMBER'])) {
      clauses.push({
        projects: {
          some: {
            members: {
              some: { userId },
            },
          },
        },
      });
    }

    const scope = this.toWhere(clauses);
    if (!organizationId) return scope;

    return {
      AND: [scope, { organizationId }],
    };
  }

  async assertCanViewDepartment(
    userId: string,
    roles: Role[],
    departmentId: string,
  ) {
    const department = await this.prisma.department.findFirst({
      where: {
        id: departmentId,
        ...this.buildAccessibleDepartmentWhere(userId, roles),
      },
      select: { id: true },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }
  }

  async assertCanManageDepartment(
    userId: string,
    roles: Role[],
    departmentId: string,
  ) {
    if (roles.includes('ADMIN')) return;

    const department = await this.prisma.department.findFirst({
      where: {
        id: departmentId,
        OR: [
          ...(roles.includes('ORGANIZATION_MANAGER')
            ? [
                {
                  organization: {
                    userRoles: {
                      some: {
                        userId,
                        role: PrismaRole.ORGANIZATION_MANAGER,
                      },
                    },
                  },
                },
              ]
            : []),
          ...(roles.includes('DEPARTMENT_MANAGER')
            ? [
                {
                  userRoles: {
                    some: {
                      userId,
                      role: PrismaRole.DEPARTMENT_MANAGER,
                    },
                  },
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });

    if (!department) {
      throw new ForbiddenException(
        'You do not have permission to manage this department',
      );
    }
  }

  async assertCanCreateDepartment(
    userId: string,
    roles: Role[],
    organizationId: string,
  ) {
    if (roles.includes('ADMIN')) return;

    if (!roles.includes('ORGANIZATION_MANAGER')) {
      throw new ForbiddenException(
        'You do not have permission to create departments',
      );
    }

    const organizationRole = await this.prisma.userRole.findFirst({
      where: {
        userId,
        role: PrismaRole.ORGANIZATION_MANAGER,
        organizationId,
      },
      select: { id: true },
    });

    if (!organizationRole) {
      throw new ForbiddenException(
        'You do not manage the selected organization',
      );
    }
  }

  private toWhere(clauses: Prisma.DepartmentWhereInput[]) {
    if (clauses.length === 0) return { id: '__no_access__' };
    return clauses.length === 1 ? clauses[0] : { OR: clauses };
  }

  private hasAnyRole(userRoles: Role[], allowed: Role[]) {
    return allowed.some((role) => userRoles.includes(role));
  }
}
