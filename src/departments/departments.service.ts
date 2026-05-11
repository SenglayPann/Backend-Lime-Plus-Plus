import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDepartmentDto } from './dto/create-department.dto';

@Injectable()
export class DepartmentsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateDepartmentDto) {
    return this.prisma.department.create({
      data: {
        name: dto.name,
        organizationId: dto.organization_id,
      },
    });
  }

  async findAll(organizationId?: string) {
    return this.prisma.department.findMany({
      where: organizationId ? { organizationId } : {},
      include: { 
        organization: true,
        _count: {
          select: { projects: true }
        }
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.department.findUnique({
      where: { id },
      include: { organization: true, projects: true },
    });
  }

  async update(id: string, dto: any) {
    return this.prisma.department.update({
      where: { id },
      data: {
        name: dto.name,
        organizationId: dto.organization_id,
      },
    });
  }

  async remove(id: string) {
    return this.prisma.department.delete({
      where: { id },
    });
  }
}
