import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { DepartmentAccessService } from '../common/access/department-access.service';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class DepartmentsService {
  constructor(
    private prisma: PrismaService,
    private departmentAccessService: DepartmentAccessService,
  ) {}

  async create(dto: CreateDepartmentDto, actorId: string, actorRoles: Role[]) {
    await this.departmentAccessService.assertCanCreateDepartment(
      actorId,
      actorRoles,
      dto.organization_id,
    );

    return this.prisma.department.create({
      data: {
        name: dto.name,
        organizationId: dto.organization_id,
        description: dto.description,
      },
    });
  }

  async findAll(actorId: string, actorRoles: Role[], organizationId?: string) {
    return this.prisma.department.findMany({
      where: this.departmentAccessService.buildAccessibleDepartmentWhere(
        actorId,
        actorRoles,
        organizationId,
      ),
      include: {
        organization: true,
        _count: {
          select: { projects: true },
        },
      },
    });
  }

  async findOne(id: string, actorId: string, actorRoles: Role[]) {
    await this.departmentAccessService.assertCanViewDepartment(
      actorId,
      actorRoles,
      id,
    );

    return this.prisma.department.findUnique({
      where: { id },
      include: { organization: true, projects: true },
    });
  }

  async update(id: string, dto: any, actorId: string, actorRoles: Role[]) {
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

    return this.prisma.department.update({
      where: { id },
      data: {
        name: dto.name,
        organizationId: dto.organization_id,
        description: dto.description,
      },
    });
  }

  async remove(id: string, actorId: string, actorRoles: Role[]) {
    await this.departmentAccessService.assertCanManageDepartment(
      actorId,
      actorRoles,
      id,
    );

    return this.prisma.department.delete({
      where: { id },
    });
  }
}
