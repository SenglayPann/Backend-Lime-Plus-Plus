import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role as PrismaRole } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
import type { Role } from '../decorators/roles.decorator';

@Injectable()
export class OrganizationAccessService {
  constructor(private readonly prisma: PrismaService) {}

  buildAccessibleOrganizationWhere(
    userId: string,
    roles: Role[],
  ): Prisma.OrganizationWhereInput {
    if (roles.includes('ADMIN')) {
      return {};
    }

    const clauses: Prisma.OrganizationWhereInput[] = [];

    if (roles.includes('ORGANIZATION_MANAGER')) {
      clauses.push({
        userRoles: {
          some: {
            userId,
            role: PrismaRole.ORGANIZATION_MANAGER,
          },
        },
      });
    }

    if (roles.includes('DEPARTMENT_MANAGER')) {
      clauses.push({
        departments: {
          some: {
            userRoles: {
              some: {
                userId,
                role: PrismaRole.DEPARTMENT_MANAGER,
              },
            },
          },
        },
      });
    }

    if (this.hasAnyRole(roles, ['PROJECT_MANAGER', 'PROJECT_MEMBER'])) {
      clauses.push({
        departments: {
          some: {
            projects: {
              some: {
                members: {
                  some: { userId },
                },
              },
            },
          },
        },
      });
    }

    return this.toWhere(clauses);
  }

  async assertCanViewOrganization(
    userId: string,
    roles: Role[],
    organizationId: string,
  ) {
    const organization = await this.prisma.organization.findFirst({
      where: {
        id: organizationId,
        ...this.buildAccessibleOrganizationWhere(userId, roles),
      },
      select: { id: true },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
  }

  async assertCanManageOrganization(
    userId: string,
    roles: Role[],
    organizationId: string,
  ) {
    if (roles.includes('ADMIN')) return;

    if (!roles.includes('ORGANIZATION_MANAGER')) {
      throw new ForbiddenException(
        'You do not have permission to manage this organization',
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
        'You do not have permission to manage this organization',
      );
    }
  }

  private toWhere(clauses: Prisma.OrganizationWhereInput[]) {
    if (clauses.length === 0) return { id: '__no_access__' };
    return clauses.length === 1 ? clauses[0] : { OR: clauses };
  }

  private hasAnyRole(userRoles: Role[], allowed: Role[]) {
    return allowed.some((role) => userRoles.includes(role));
  }
}
