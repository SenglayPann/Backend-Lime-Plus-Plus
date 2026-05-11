import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get global dashboard statistics' })
  async getStats() {
    return this.dashboardService.getGlobalStats();
  }

  @Get('activity')
  @ApiOperation({ summary: 'Get recent merged PR activity' })
  async getActivity() {
    return this.dashboardService.getRecentActivity();
  }

  @Get('departments')
  @ApiOperation({ summary: 'Get top performing departments' })
  async getDepartments() {
    return this.dashboardService.getTopDepartments();
  }
}
