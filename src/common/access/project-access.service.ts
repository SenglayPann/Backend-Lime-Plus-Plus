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

    if (this.hasAnyRole(roles, ['ADMIN', 'ORGANIZATION_OWNER'])) {
      clauses.push({});
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

  async assertCanCreateProjectInDepartment(
    userId: string,
    roles: Role[],
    departmentId: string,
  ) {
    if (this.hasAnyRole(roles, ['ADMIN', 'ORGANIZATION_OWNER'])) {
      return;
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
      throw new ForbiddenException(
        'You do not manage the selected department',
      );
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
    const managementClauses: Prisma.ProjectWhereInput[] = [];

    if (this.hasAnyRole(roles, ['ADMIN', 'ORGANIZATION_OWNER'])) {
      managementClauses.push({});
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

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        ...(managementClauses.length === 1
          ? managementClauses[0]
          : { OR: managementClauses }),
      },
      select: { id: true },
    });

    if (!project) {
      throw new ForbiddenException(
        'You do not have permission to manage this project',
      );
    }
  }

  private hasAnyRole(userRoles: Role[], allowed: Role[]) {
    return allowed.some((role) => userRoles.includes(role));
  }
}
