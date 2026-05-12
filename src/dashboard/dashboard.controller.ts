import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get scoped dashboard statistics' })
  async getStats(@Request() req: RequestWithUser) {
    return this.dashboardService.getGlobalStats(req.user.id, req.user.roles);
  }

  @Get('activity')
  @ApiOperation({ summary: 'Get recent activity within visible scope' })
  async getActivity(@Request() req: RequestWithUser) {
    return this.dashboardService.getRecentActivity(req.user.id, req.user.roles);
  }

  @Get('departments')
  @ApiOperation({ summary: 'Get top departments within visible scope' })
  async getDepartments(@Request() req: RequestWithUser) {
    return this.dashboardService.getTopDepartments(req.user.id, req.user.roles);
  }

  @Get('my-contributions')
  @ApiOperation({ summary: 'Get the current user contribution workspace' })
  async getMyContributions(@Request() req: RequestWithUser) {
    return this.dashboardService.getMyContributions(req.user.id);
  }
}
