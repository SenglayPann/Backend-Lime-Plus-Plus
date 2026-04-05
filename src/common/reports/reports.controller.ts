import { Controller, Get, Param, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { Roles } from '../decorators/roles.decorator';
import { Role } from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('projects/:projectId/users/:userId/individual')
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Export individual performance report' })
  async individual(@Param('projectId') projectId: string, @Param('userId') userId: string) {
    const report = await this.reportsService.generateIndividualReport(projectId, userId);
    if (!report) throw new NotFoundException('Data not found for report');
    return report;
  }

  @Get('projects/:projectId/summary')
  @Roles(Role.DEPARTMENT_MANAGER)
  @ApiOperation({ summary: 'Export project-wide performance report' })
  async project(@Param('projectId') projectId: string) {
    return this.reportsService.generateProjectReport(projectId);
  }
}
