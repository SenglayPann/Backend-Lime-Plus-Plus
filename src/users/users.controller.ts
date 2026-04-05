import { Controller, Get, Post, Body, Param, Delete, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { AssignRoleDto } from './dto/assign-role.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all users (Admin only)' })
  async findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user details with roles' })
  async findOne(@Param('id') id: string) {
    const user = await this.usersService.getUserWithRoles(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Post(':userId/roles')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Assign a role to a user (Admin only)' })
  async assignRole(
    @Param('userId') userId: string,
    @Body() dto: AssignRoleDto,
  ) {
    return this.usersService.assignRole(
      userId,
      dto.role,
      dto.organization_id,
      dto.department_id,
    );
  }

  @Delete('roles/:roleId')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Remove a role from a user (Admin only)' })
  async removeRole(@Param('roleId') roleId: string) {
    return this.usersService.removeRole(roleId);
  }
}
