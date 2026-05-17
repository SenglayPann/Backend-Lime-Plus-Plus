import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import { DepartmentAccessService } from '../common/access/department-access.service';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import { safeUserSelect } from '../common/serialization/safe-user-select';
import { AuditAction, Prisma, Role as PrismaRole } from '../generated/prisma';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class OrganizationsService {
  constructor(
    private prisma: PrismaService,
    private organizationAccessService: OrganizationAccessService,
    private departmentAccessService: DepartmentAccessService,
    private roleDelegationService: RoleDelegationService,
  ) {}

  async create(dto: CreateOrganizationDto, actorId: string, actorRoles: Role[]) {
    const name = this.normalizeRequiredName(dto.name, 'Organization name');
    await this.assertOrganizationNameAvailable(name);

    if (dto.manager_user_id) {
      await this.assertOrganizationManagerTargetCanBeAssigned(
        dto.manager_user_id,
        actorId,
        actorRoles,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const organization = await (async () => {
        try {
          return await tx.organization.create({
            data: {
              name,
              licensePlan: dto.license_plan,
            },
          });
        } catch (error) {
          if (this.isUniqueConstraintError(error)) {
            throw new ConflictException(
              'An organization with this name already exists',
            );
          }

          throw error;
        }
      })();

      if (dto.manager_user_id) {
        await tx.userRole.create({
          data: {
            userId: dto.manager_user_id,
            role: PrismaRole.ORGANIZATION_MANAGER,
            organizationId: organization.id,
          },
        });

        await tx.auditLog.create({
          data: {
            action: AuditAction.ROLE_CHANGE,
            actorId,
            metadata: {
              operation: 'assign',
              targetUserId: dto.manager_user_id,
              role: PrismaRole.ORGANIZATION_MANAGER,
              organizationId: organization.id,
            },
          },
        });
      }

      return organization;
    });
  }

  async findAll(actorId: string, actorRoles: Role[], search?: string) {
    const accessibleWhere =
      this.organizationAccessService.buildAccessibleOrganizationWhere(
        actorId,
        actorRoles,
      );
    const searchWhere = this.buildOrganizationSearchWhere(search);

    return this.prisma.organization.findMany({
      where: searchWhere
        ? { AND: [accessibleWhere, searchWhere] }
        : accessibleWhere,
      include: {
        userRoles: {
          where: { role: PrismaRole.ORGANIZATION_MANAGER },
          include: { user: { select: safeUserSelect } },
        },
        _count: {
          select: {
            departments: true,
            userRoles: true,
          },
        },
      },
    });
  }

  private buildOrganizationSearchWhere(
    search?: string,
  ): Prisma.OrganizationWhereInput | undefined {
    const term = search?.trim();
    if (!term) return undefined;

    const contains = { contains: term, mode: Prisma.QueryMode.insensitive };
    const userNameSearch: Prisma.UserWhereInput = {
      OR: [
        { name: contains },
        { email: contains },
        { githubUsername: contains },
      ],
    };

    return {
      OR: [
        { name: contains },
        { licensePlan: contains },
        {
          userRoles: {
            some: {
              role: PrismaRole.ORGANIZATION_MANAGER,
              user: userNameSearch,
            },
          },
        },
      ],
    };
  }

  async findOne(id: string, actorId: string, actorRoles: Role[]) {
    await this.organizationAccessService.assertCanViewOrganization(
      actorId,
      actorRoles,
      id,
    );

    return this.prisma.organization.findUnique({
      where: { id },
      include: {
        userRoles: {
          where: { role: PrismaRole.ORGANIZATION_MANAGER },
          include: { user: { select: safeUserSelect } },
        },
        departments: {
          where: this.departmentAccessService.buildAccessibleDepartmentWhere(
            actorId,
            actorRoles,
            id,
          ),
        },
      },
    });
  }

  async update(
    id: string,
    dto: UpdateOrganizationDto,
    actorId: string,
    actorRoles: Role[],
  ) {
    const name =
      dto.name !== undefined
        ? this.normalizeRequiredName(dto.name, 'Organization name')
        : undefined;

    if (name !== undefined) {
      await this.assertOrganizationNameAvailable(name, id);
    }

    if (dto.manager_user_id) {
      await this.assertOrganizationManagerTargetCanBeAssigned(
        dto.manager_user_id,
        actorId,
        actorRoles,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      try {
        await tx.organization.update({
          where: { id },
          data: {
            name,
            licensePlan: dto.license_plan,
          },
        });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          throw new ConflictException(
            'An organization with this name already exists',
          );
        }

        throw error;
      }

      if (dto.manager_user_id) {
        const existingRole = await tx.userRole.findFirst({
          where: {
            userId: dto.manager_user_id,
            role: PrismaRole.ORGANIZATION_MANAGER,
            organizationId: id,
          },
          select: { id: true },
        });

        if (!existingRole) {
          await tx.userRole.create({
            data: {
              userId: dto.manager_user_id,
              role: PrismaRole.ORGANIZATION_MANAGER,
              organizationId: id,
            },
          });

          await tx.auditLog.create({
            data: {
              action: AuditAction.ROLE_CHANGE,
              actorId,
              metadata: {
                operation: 'assign',
                targetUserId: dto.manager_user_id,
                role: PrismaRole.ORGANIZATION_MANAGER,
                organizationId: id,
              },
            },
          });
        }
      }

      return tx.organization.findUnique({
        where: { id },
        include: {
          userRoles: {
            where: { role: PrismaRole.ORGANIZATION_MANAGER },
            include: { user: { select: safeUserSelect } },
          },
          _count: {
            select: {
              departments: true,
              userRoles: true,
            },
          },
        },
      });
    });
  }

  async remove(id: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            departments: true,
            userRoles: true,
          },
        },
      },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (
      organization._count.departments > 0 ||
      organization._count.userRoles > 0
    ) {
      throw new ConflictException(
        'Organization must be empty before it can be deleted',
      );
    }

    return this.prisma.organization.delete({
      where: { id },
    });
  }

  private async assertOrganizationManagerTargetCanBeAssigned(
    targetUserId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });

    if (!target) {
      throw new NotFoundException('Selected organization manager not found');
    }

    await this.roleDelegationService.assertTargetCanBeManaged(
      actorId,
      actorRoles,
      targetUserId,
    );
  }

  private normalizeRequiredName(name: string, label: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException(`${label} cannot be empty`);
    }

    return trimmed;
  }

  private async assertOrganizationNameAvailable(
    name: string,
    excludeOrganizationId?: string,
  ) {
    const existingOrganization = await this.prisma.organization.findFirst({
      where: {
        name: { equals: name, mode: Prisma.QueryMode.insensitive },
        ...(excludeOrganizationId
          ? { id: { not: excludeOrganizationId } }
          : {}),
      },
      select: { id: true },
    });

    if (existingOrganization) {
      throw new ConflictException(
        'An organization with this name already exists',
      );
    }
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
