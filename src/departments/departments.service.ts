import {
  BadRequestException,
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

    const name = this.normalizeRequiredName(dto.name, 'Department name');
    await this.assertDepartmentNameAvailable(dto.organization_id, name);

    if (dto.manager_user_id) {
      await this.assertDepartmentManagerTargetCanBeAssigned(
        dto.manager_user_id,
        actorId,
        actorRoles,
        dto.organization_id,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const department = await (async () => {
        try {
          return await tx.department.create({
            data: {
              name,
              organizationId: dto.organization_id,
              description: dto.description,
            },
          });
        } catch (error) {
          if (this.isUniqueConstraintError(error)) {
            throw new ConflictException(
              'A department with this name already exists in this organization',
            );
          }

          throw error;
        }
      })();

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
      select: { id: true, organizationId: true, name: true },
    });

    if (!currentDepartment) {
      throw new NotFoundException('Department not found');
    }

    const targetOrganizationId =
      dto.organization_id ?? currentDepartment.organizationId;
    const name =
      dto.name !== undefined
        ? this.normalizeRequiredName(dto.name, 'Department name')
        : undefined;
    const targetDepartmentName = name ?? currentDepartment.name;

    if (name !== undefined || dto.organization_id !== undefined) {
      await this.assertDepartmentNameAvailable(
        targetOrganizationId,
        targetDepartmentName,
        id,
      );
    }

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
      try {
        await tx.department.update({
          where: { id },
          data: {
            name,
            organizationId: dto.organization_id,
            description: dto.description,
          },
        });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          throw new ConflictException(
            'A department with this name already exists in this organization',
          );
        }

        throw error;
      }

      if (dto.manager_user_id !== undefined) {
        const currentManagers = await tx.userRole.findMany({
          where: {
            role: PrismaRole.DEPARTMENT_MANAGER,
            departmentId: id,
          },
        });

        const targetUserId = dto.manager_user_id === '' ? null : dto.manager_user_id;

        if (!targetUserId) {
          // Unassign all managers
          for (const manager of currentManagers) {
            await tx.userRole.delete({ where: { id: manager.id } });
            await tx.auditLog.create({
              data: {
                action: AuditAction.ROLE_CHANGE,
                actorId,
                metadata: {
                  operation: 'remove',
                  targetUserId: manager.userId,
                  role: PrismaRole.DEPARTMENT_MANAGER,
                  departmentId: id,
                },
              },
            });
          }
        } else {
          // Swap: remove all other managers, assign the new one if not present
          let alreadyAssigned = false;
          for (const manager of currentManagers) {
            if (manager.userId !== targetUserId) {
              await tx.userRole.delete({ where: { id: manager.id } });
              await tx.auditLog.create({
                data: {
                  action: AuditAction.ROLE_CHANGE,
                  actorId,
                  metadata: {
                    operation: 'remove',
                    targetUserId: manager.userId,
                    role: PrismaRole.DEPARTMENT_MANAGER,
                    departmentId: id,
                  },
                },
              });
            } else {
              alreadyAssigned = true;
            }
          }

          if (!alreadyAssigned) {
            await tx.userRole.create({
              data: {
                userId: targetUserId,
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
                  targetUserId,
                  role: PrismaRole.DEPARTMENT_MANAGER,
                  departmentId: id,
                },
              },
            });
          }
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

  private normalizeRequiredName(name: string, label: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException(`${label} cannot be empty`);
    }

    return trimmed;
  }

  private async assertDepartmentNameAvailable(
    organizationId: string,
    name: string,
    excludeDepartmentId?: string,
  ) {
    const existingDepartment = await this.prisma.department.findFirst({
      where: {
        organizationId,
        name: { equals: name, mode: Prisma.QueryMode.insensitive },
        ...(excludeDepartmentId ? { id: { not: excludeDepartmentId } } : {}),
      },
      select: { id: true },
    });

    if (existingDepartment) {
      throw new ConflictException(
        'A department with this name already exists in this organization',
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
