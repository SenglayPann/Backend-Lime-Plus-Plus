import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role as PrismaRole } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
import type { Role } from '../decorators/roles.decorator';

@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  buildAccessibleProjectWhere(
    userId: string,
    roles: Role[],
    departmentId?: string,
  ): Prisma.ProjectWhereInput {
    const clauses: Prisma.ProjectWhereInput[] = [];

    if (roles.includes('ADMIN')) {
      clauses.push({});
    }

    if (roles.includes('ORGANIZATION_MANAGER')) {
      clauses.push({
        department: {
          organization: {
            userRoles: {
              some: {
                userId,
                role: PrismaRole.ORGANIZATION_MANAGER,
              },
            },
          },
        },
      });
    }

    if (roles.includes('DEPARTMENT_MANAGER')) {
      clauses.push({
        department: {
          userRoles: {
            some: {
              userId,
              role: PrismaRole.DEPARTMENT_MANAGER,
            },
          },
        },
      });
    }

    if (this.hasAnyRole(roles, ['PROJECT_MANAGER', 'PROJECT_MEMBER'])) {
      clauses.push({
        members: {
          some: {
            userId,
          },
        },
      });
    }

    if (clauses.length === 0) {
      return {
        id: '__no_access__',
      };
    }

    const scope: Prisma.ProjectWhereInput =
      clauses.length === 1 ? clauses[0] : { OR: clauses };

    if (!departmentId) {
      return scope;
    }

    return {
      AND: [scope, { departmentId }],
    };
  }

  async getAccessibleProjectIds(
    userId: string,
    roles: Role[],
    departmentId?: string,
  ): Promise<string[]> {
    const projects = await this.prisma.project.findMany({
      where: this.buildAccessibleProjectWhere(userId, roles, departmentId),
      select: { id: true },
    });

    return projects.map((project) => project.id);
  }

  async getManageableProjectIds(
    userId: string,
    roles: Role[],
    departmentId?: string,
  ): Promise<string[]> {
    const where = this.buildManageableProjectWhere(userId, roles, departmentId);

    if (!where) {
      return [];
    }

    const projects = await this.prisma.project.findMany({
      where,
      select: { id: true },
    });

    return projects.map((project) => project.id);
  }

  async assertCanCreateProjectInDepartment(
    userId: string,
    roles: Role[],
    departmentId: string,
  ) {
    if (roles.includes('ADMIN')) {
      return;
    }

    if (roles.includes('ORGANIZATION_MANAGER')) {
      const hasOrganizationRole = await this.prisma.department.findFirst({
        where: {
          id: departmentId,
          organization: {
            userRoles: {
              some: {
                userId,
                role: PrismaRole.ORGANIZATION_MANAGER,
              },
            },
          },
        },
        select: { id: true },
      });

      if (hasOrganizationRole) {
        return;
      }
    }

    if (!roles.includes('DEPARTMENT_MANAGER')) {
      throw new ForbiddenException(
        'You do not have permission to create a project in this department',
      );
    }

    const hasDepartmentRole = await this.prisma.userRole.findFirst({
      where: {
        userId,
        role: PrismaRole.DEPARTMENT_MANAGER,
        departmentId,
      },
      select: { id: true },
    });

    if (!hasDepartmentRole) {
      throw new ForbiddenException('You do not manage the selected department');
    }
  }

  async assertCanViewProject(userId: string, roles: Role[], projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ...this.buildAccessibleProjectWhere(userId, roles),
      },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }
  }

  async assertCanManageProject(
    userId: string,
    roles: Role[],
    projectId: string,
  ) {
    const where = this.buildManageableProjectWhere(userId, roles);

    if (!where) {
      throw new ForbiddenException(
        'You do not have permission to manage this project',
      );
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ...where,
      },
      select: { id: true },
    });

    if (!project) {
      throw new ForbiddenException(
        'You do not have permission to manage this project',
      );
    }
  }

  async canManageProject(
    userId: string,
    roles: Role[],
    projectId: string,
  ): Promise<boolean> {
    const where = this.buildManageableProjectWhere(userId, roles);

    if (!where) {
      return false;
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ...where,
      },
      select: { id: true },
    });

    return !!project;
  }

  buildManageableProjectWhere(
    userId: string,
    roles: Role[],
    departmentId?: string,
  ): Prisma.ProjectWhereInput | null {
    const managementClauses: Prisma.ProjectWhereInput[] = [];

    if (roles.includes('ADMIN')) {
      managementClauses.push({});
    }

    if (roles.includes('ORGANIZATION_MANAGER')) {
      managementClauses.push({
        department: {
          organization: {
            userRoles: {
              some: {
                userId,
                role: PrismaRole.ORGANIZATION_MANAGER,
              },
            },
          },
        },
      });
    }

    if (roles.includes('DEPARTMENT_MANAGER')) {
      managementClauses.push({
        department: {
          userRoles: {
            some: {
              userId,
              role: PrismaRole.DEPARTMENT_MANAGER,
            },
          },
        },
      });
    }

    if (roles.includes('PROJECT_MANAGER')) {
      managementClauses.push({
        members: {
          some: {
            userId,
            role: PrismaRole.PROJECT_MANAGER,
          },
        },
      });
    }

    if (managementClauses.length === 0) {
      return null;
    }

    const scope: Prisma.ProjectWhereInput =
      managementClauses.length === 1
        ? managementClauses[0]
        : { OR: managementClauses };

    if (!departmentId) {
      return scope;
    }

    return {
      AND: [scope, { departmentId }],
    };
  }

  private hasAnyRole(userRoles: Role[], allowed: Role[]) {
    return allowed.some((role) => userRoles.includes(role));
  }
}
