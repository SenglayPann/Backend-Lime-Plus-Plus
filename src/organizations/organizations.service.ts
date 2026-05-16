import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import { DepartmentAccessService } from '../common/access/department-access.service';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import { safeUserSelect } from '../common/serialization/safe-user-select';
import { AuditAction, Role as PrismaRole } from '../generated/prisma';
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
    if (dto.manager_user_id) {
      await this.assertOrganizationManagerTargetCanBeAssigned(
        dto.manager_user_id,
        actorId,
        actorRoles,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: dto.name,
          licensePlan: dto.license_plan,
        },
      });

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

  async findAll(actorId: string, actorRoles: Role[]) {
    return this.prisma.organization.findMany({
      where: this.organizationAccessService.buildAccessibleOrganizationWhere(
        actorId,
        actorRoles,
      ),
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
    if (dto.manager_user_id) {
      await this.assertOrganizationManagerTargetCanBeAssigned(
        dto.manager_user_id,
        actorId,
        actorRoles,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id },
        data: {
          name: dto.name,
          licensePlan: dto.license_plan,
        },
      });

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
}
