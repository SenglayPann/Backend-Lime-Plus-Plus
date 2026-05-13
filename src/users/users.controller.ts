import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Request,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { AssignRoleDto } from './dto/assign-role.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'List visible users' })
  async findAll(@Request() req: RequestWithUser) {
    return this.usersService.findAll(req.user.id, req.user.roles);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user details with roles' })
  async findOne(@Param('id') id: string, @Request() req: RequestWithUser) {
    const user = await this.usersService.getUserWithRoles(
      id,
      req.user.id,
      req.user.roles,
    );
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  @Post(':userId/roles')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'Assign a scoped role to a user' })
  async assignRole(
    @Param('userId') userId: string,
    @Body() dto: AssignRoleDto,
    @Request() req: RequestWithUser,
  ) {
    return this.usersService.assignRole(
      userId,
      dto.role,
      req.user.id,
      req.user.roles,
      dto.organization_id,
      dto.department_id,
    );
  }

  @Delete('roles/:roleId')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'Remove a scoped role from a user' })
  async removeRole(
    @Param('roleId') roleId: string,
    @Request() req: RequestWithUser,
  ) {
    return this.usersService.removeRole(roleId, req.user.id, req.user.roles);
  }
}
