import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Get scoped dashboard statistics' })
  async getStats(@Request() req: RequestWithUser) {
    return this.dashboardService.getGlobalStats(req.user.id, req.user.roles);
  }

  @Get('activity')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Get recent activity within visible scope' })
  async getActivity(@Request() req: RequestWithUser) {
    return this.dashboardService.getRecentActivity(req.user.id, req.user.roles);
  }

  @Get('departments')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Get top departments within visible scope' })
  async getDepartments(@Request() req: RequestWithUser) {
    return this.dashboardService.getTopDepartments(req.user.id, req.user.roles);
  }

  @Get('organizations/:organizationId')
  @Roles(Role.ORGANIZATION_MANAGER)
  @ApiOperation({ summary: 'Get organization dashboard summary' })
  async getOrganizationDashboard(
    @Param('organizationId') organizationId: string,
    @Request() req: RequestWithUser,
  ) {
    return this.dashboardService.getOrganizationDashboard(
      organizationId,
      req.user.id,
      req.user.roles,
    );
  }

  @Get('departments/:departmentId')
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Get department dashboard summary' })
  async getDepartmentDashboard(
    @Param('departmentId') departmentId: string,
    @Request() req: RequestWithUser,
  ) {
    return this.dashboardService.getDepartmentDashboard(
      departmentId,
      req.user.id,
      req.user.roles,
    );
  }

  @Get('my-contributions')
  @ApiOperation({ summary: 'Get the current user contribution workspace' })
  async getMyContributions(@Request() req: RequestWithUser) {
    return this.dashboardService.getMyContributions(req.user.id);
  }
}
