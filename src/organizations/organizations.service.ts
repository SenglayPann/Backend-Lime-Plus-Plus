import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class OrganizationsService {
  constructor(
    private prisma: PrismaService,
    private organizationAccessService: OrganizationAccessService,
  ) {}

  async create(dto: CreateOrganizationDto) {
    return this.prisma.organization.create({
      data: {
        name: dto.name,
        licensePlan: dto.license_plan,
      },
    });
  }

  async findAll(actorId: string, actorRoles: Role[]) {
    return this.prisma.organization.findMany({
      where: this.organizationAccessService.buildAccessibleOrganizationWhere(
        actorId,
        actorRoles,
      ),
      include: {
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
      include: { departments: true },
    });
  }

  async update(id: string, dto: UpdateOrganizationDto) {
    return this.prisma.organization.update({
      where: { id },
      data: {
        name: dto.name,
        licensePlan: dto.license_plan,
      },
    });
  }

  async remove(id: string) {
    return this.prisma.organization.delete({
      where: { id },
    });
  }
}
