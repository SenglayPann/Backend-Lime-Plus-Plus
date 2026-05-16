import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Departments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Post()
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'Create a new department (Org Manager+)' })
  async create(
    @Body() createDepartmentDto: CreateDepartmentDto,
    @Request() req: RequestWithUser,
  ) {
    return this.departmentsService.create(
      createDepartmentDto,
      req.user.id,
      req.user.roles,
    );
  }

  @Get()
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'List accessible departments' })
  @ApiQuery({
    name: 'organization_id',
    required: false,
    description: 'Filter by organization ID',
  })
  async findAll(
    @Query('organization_id') organizationId: string | undefined,
    @Request() req: RequestWithUser,
  ) {
    return this.departmentsService.findAll(
      req.user.id,
      req.user.roles,
      organizationId,
    );
  }

  @Get(':id')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'Get department details' })
  async findOne(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.departmentsService.findOne(id, req.user.id, req.user.roles);
  }

  @Patch(':id')
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Update a department (Dept Manager+)' })
  async update(
    @Param('id') id: string,
    @Body() updateDepartmentDto: UpdateDepartmentDto,
    @Request() req: RequestWithUser,
  ) {
    return this.departmentsService.update(
      id,
      updateDepartmentDto,
      req.user.id,
      req.user.roles,
    );
  }

  @Delete(':id')
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Delete an empty department (Dept Manager+)' })
  async remove(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.departmentsService.remove(id, req.user.id, req.user.roles);
  }
}
