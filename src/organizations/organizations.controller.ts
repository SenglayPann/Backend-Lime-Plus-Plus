import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a new organization (Admin only)' })
  async create(@Body() createOrganizationDto: CreateOrganizationDto) {
    return this.organizationsService.create(createOrganizationDto);
  }

  @Get()
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'List accessible organizations' })
  async findAll(@Request() req: RequestWithUser) {
    return this.organizationsService.findAll(req.user.id, req.user.roles);
  }

  @Get(':id')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'Get organization details' })
  async findOne(@Param('id') id: string, @Request() req: RequestWithUser) {
    return this.organizationsService.findOne(id, req.user.id, req.user.roles);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update an organization (Admin only)' })
  async update(
    @Param('id') id: string,
    @Body() updateOrganizationDto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(id, updateOrganizationDto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete an organization (Admin only)' })
  async remove(@Param('id') id: string) {
    return this.organizationsService.remove(id);
  }
}
