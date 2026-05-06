import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  StreamableFile,
  Header,
  Response,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { Roles } from '../decorators/roles.decorator';
import { Role } from '../../generated/prisma';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';

class ReportDto {
  project_id: string;
  user_id?: string;
  format: 'pdf' | 'csv';
}

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post('individual')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER, Role.ADMIN)
  @ApiOperation({ summary: 'Generate individual report (Spec v1)' })
  async generateIndividualReport(@Body() dto: ReportDto) {
    const buffer = await this.reportsService.exportIndividualPdf(
      dto.project_id,
      dto.user_id!,
    );
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="report_${dto.user_id}.pdf"`,
    });
  }

  @Post('project')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER, Role.ADMIN)
  @ApiOperation({ summary: 'Generate project report (Spec v1)' })
  async generateProjectReport(@Body() dto: ReportDto) {
    if (dto.format === 'csv') {
      const csv = await this.reportsService.exportProjectCsv(dto.project_id);
      return csv; // NestJS will return as text/plain or we can use StreamableFile
    }
    const buffer = await this.reportsService.exportProjectPdf(dto.project_id);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: 'attachment; filename="project_report.pdf"',
    });
  }

  @Get('projects/:projectId/users/:userId/pdf')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'attachment; filename="individual_report.pdf"')
  @ApiOperation({
    summary: 'Export individual performance report as PDF (Legacy GET)',
  })
  async individualPdf(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    const buffer = await this.reportsService.exportIndividualPdf(
      projectId,
      userId,
    );
    return new StreamableFile(buffer);
  }

  @Get('projects/:projectId/pdf')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'attachment; filename="project_report.pdf"')
  @ApiOperation({
    summary: 'Export project-wide performance report as PDF (Legacy GET)',
  })
  async projectPdf(@Param('projectId') projectId: string) {
    const buffer = await this.reportsService.exportProjectPdf(projectId);
    return new StreamableFile(buffer);
  }

  @Get('projects/:projectId/csv')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="project_scores.csv"')
  @ApiOperation({
    summary: 'Export project-wide performance scores as CSV (Legacy GET)',
  })
  async projectCsv(@Param('projectId') projectId: string) {
    return this.reportsService.exportProjectCsv(projectId);
  }
}
