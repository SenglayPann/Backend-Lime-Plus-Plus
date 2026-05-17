import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { DepartmentAccessService } from '../common/access/department-access.service';
import { ProjectAccessService } from '../common/access/project-access.service';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import { safeUserSelect } from '../common/serialization/safe-user-select';
import { AuditAction, Prisma, Role as PrismaRole } from '../generated/prisma';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class DepartmentsService {
  constructor(
    private prisma: PrismaService,
    private departmentAccessService: DepartmentAccessService,
    private projectAccessService: ProjectAccessService,
    private roleDelegationService: RoleDelegationService,
  ) {}

  async create(dto: CreateDepartmentDto, actorId: string, actorRoles: Role[]) {
    await this.departmentAccessService.assertCanCreateDepartment(
      actorId,
      actorRoles,
      dto.organization_id,
    );

    if (dto.manager_user_id) {
      await this.assertDepartmentManagerTargetCanBeAssigned(
        dto.manager_user_id,
        actorId,
        actorRoles,
        dto.organization_id,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const department = await tx.department.create({
        data: {
          name: dto.name,
          organizationId: dto.organization_id,
          description: dto.description,
        },
      });

      if (dto.manager_user_id) {
        await tx.userRole.create({
          data: {
            userId: dto.manager_user_id,
            role: PrismaRole.DEPARTMENT_MANAGER,
            departmentId: department.id,
          },
        });

        await tx.auditLog.create({
          data: {
            action: AuditAction.ROLE_CHANGE,
            actorId,
            metadata: {
              operation: 'assign',
              targetUserId: dto.manager_user_id,
              role: PrismaRole.DEPARTMENT_MANAGER,
              departmentId: department.id,
            },
          },
        });
      }

      return department;
    });
  }

  async findAll(
    actorId: string,
    actorRoles: Role[],
    organizationId?: string,
    search?: string,
  ) {
    const accessibleWhere =
      this.departmentAccessService.buildAccessibleDepartmentWhere(
        actorId,
        actorRoles,
        organizationId,
      );
    const searchWhere = this.buildDepartmentSearchWhere(search);

    return this.prisma.department.findMany({
      where: searchWhere
        ? { AND: [accessibleWhere, searchWhere] }
        : accessibleWhere,
      include: {
        organization: true,
        userRoles: {
          where: { role: PrismaRole.DEPARTMENT_MANAGER },
          include: { user: { select: safeUserSelect } },
        },
        _count: {
          select: { projects: true },
        },
      },
    });
  }

  private buildDepartmentSearchWhere(
    search?: string,
  ): Prisma.DepartmentWhereInput | undefined {
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
        { description: contains },
        { organization: { name: contains } },
        {
          userRoles: {
            some: {
              role: PrismaRole.DEPARTMENT_MANAGER,
              user: userNameSearch,
            },
          },
        },
      ],
    };
  }

  async findOne(id: string, actorId: string, actorRoles: Role[]) {
    await this.departmentAccessService.assertCanViewDepartment(
      actorId,
      actorRoles,
      id,
    );

    return this.prisma.department.findUnique({
      where: { id },
      include: {
        organization: true,
        userRoles: {
          where: { role: PrismaRole.DEPARTMENT_MANAGER },
          include: { user: { select: safeUserSelect } },
        },
        projects: {
          where: this.projectAccessService.buildAccessibleProjectWhere(
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
    dto: UpdateDepartmentDto,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.departmentAccessService.assertCanManageDepartment(
      actorId,
      actorRoles,
      id,
    );

    if (dto.organization_id) {
      await this.departmentAccessService.assertCanCreateDepartment(
        actorId,
        actorRoles,
        dto.organization_id,
      );
    }

    const currentDepartment = await this.prisma.department.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });

    if (!currentDepartment) {
      throw new NotFoundException('Department not found');
    }

    const targetOrganizationId =
      dto.organization_id ?? currentDepartment.organizationId;

    if (dto.manager_user_id) {
      await this.departmentAccessService.assertCanCreateDepartment(
        actorId,
        actorRoles,
        targetOrganizationId,
      );
      await this.assertDepartmentManagerTargetCanBeAssigned(
        dto.manager_user_id,
        actorId,
        actorRoles,
        targetOrganizationId,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.department.update({
        where: { id },
        data: {
          name: dto.name,
          organizationId: dto.organization_id,
          description: dto.description,
        },
      });

      if (dto.manager_user_id) {
        const existingRole = await tx.userRole.findFirst({
          where: {
            userId: dto.manager_user_id,
            role: PrismaRole.DEPARTMENT_MANAGER,
            departmentId: id,
          },
          select: { id: true },
        });

        if (!existingRole) {
          await tx.userRole.create({
            data: {
              userId: dto.manager_user_id,
              role: PrismaRole.DEPARTMENT_MANAGER,
              departmentId: id,
            },
          });

          await tx.auditLog.create({
            data: {
              action: AuditAction.ROLE_CHANGE,
              actorId,
              metadata: {
                operation: 'assign',
                targetUserId: dto.manager_user_id,
                role: PrismaRole.DEPARTMENT_MANAGER,
                departmentId: id,
              },
            },
          });
        }
      }

      return tx.department.findUnique({
        where: { id },
        include: {
          organization: true,
          userRoles: {
            where: { role: PrismaRole.DEPARTMENT_MANAGER },
            include: { user: { select: safeUserSelect } },
          },
          _count: {
            select: { projects: true },
          },
        },
      });
    });
  }

  async remove(id: string, actorId: string, actorRoles: Role[]) {
    await this.departmentAccessService.assertCanManageDepartment(
      actorId,
      actorRoles,
      id,
    );

    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            projects: true,
            userRoles: true,
          },
        },
      },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    if (department._count.projects > 0 || department._count.userRoles > 0) {
      throw new ConflictException(
        'Department must be empty before it can be deleted',
      );
    }

    return this.prisma.department.delete({
      where: { id },
    });
  }

  private async assertDepartmentManagerTargetCanBeAssigned(
    targetUserId: string,
    actorId: string,
    actorRoles: Role[],
    organizationId: string,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });

    if (!target) {
      throw new NotFoundException('Selected department manager not found');
    }

    if (!actorRoles.includes('ADMIN') && targetUserId !== actorId) {
      await this.roleDelegationService.assertTargetCanBeManaged(
        actorId,
        actorRoles,
        targetUserId,
      );

      const visibleTarget = await this.prisma.user.findFirst({
        where: {
          AND: [
            { id: targetUserId },
            this.buildUserInOrganizationWhere(organizationId),
          ],
        },
        select: { id: true },
      });

      if (!visibleTarget) {
        throw new ForbiddenException(
          'Selected department manager is outside the selected organization',
        );
      }
    }
  }

  private buildUserInOrganizationWhere(
    organizationId: string,
  ): Prisma.UserWhereInput {
    return {
      OR: [
        {
          userRoles: {
            some: { organizationId },
          },
        },
        {
          userRoles: {
            some: {
              department: { organizationId },
            },
          },
        },
        {
          projectMembers: {
            some: {
              project: {
                department: { organizationId },
              },
            },
          },
        },
      ],
    };
  }
}
