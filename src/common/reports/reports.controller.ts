import { Controller, Get, Param, UseGuards, StreamableFile, Header, Response } from '@nestjs/common';
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

  @Get('projects/:projectId/users/:userId/pdf')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'attachment; filename="individual_report.pdf"')
  @ApiOperation({ summary: 'Export individual performance report as PDF' })
  async individualPdf(@Param('projectId') projectId: string, @Param('userId') userId: string) {
    const buffer = await this.reportsService.exportIndividualPdf(projectId, userId);
    return new StreamableFile(buffer);
  }

  @Get('projects/:projectId/pdf')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'attachment; filename="project_report.pdf"')
  @ApiOperation({ summary: 'Export project-wide performance report as PDF' })
  async projectPdf(@Param('projectId') projectId: string) {
    const buffer = await this.reportsService.exportProjectPdf(projectId);
    return new StreamableFile(buffer);
  }

  @Get('projects/:projectId/csv')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="project_scores.csv"')
  @ApiOperation({ summary: 'Export project-wide performance scores as CSV' })
  async projectCsv(@Param('projectId') projectId: string) {
    return this.reportsService.exportProjectCsv(projectId);
  }
}
