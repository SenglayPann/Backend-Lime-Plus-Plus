import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Request,
  UseGuards,
  StreamableFile,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { Roles } from '../decorators/roles.decorator';
import { Role } from '../../generated/prisma';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import type { RequestWithUser } from '../types/request.interface';

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
  @Roles(
    Role.DEPARTMENT_MANAGER,
    Role.PROJECT_MANAGER,
    Role.PROJECT_MEMBER,
    Role.ADMIN,
  )
  @ApiOperation({ summary: 'Generate individual report (Spec v1)' })
  async generateIndividualReport(
    @Body() dto: ReportDto,
    @Request() req: RequestWithUser,
  ) {
    const userId = dto.user_id || req.user.id;
    const buffer = await this.reportsService.exportIndividualPdf(
      dto.project_id,
      userId,
      req.user.id,
      req.user.roles,
    );
    return this.pdfFile(buffer, `lime_individual_report_${userId}.pdf`);
  }

  @Post('project')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER, Role.ADMIN)
  @ApiOperation({ summary: 'Generate project report (Spec v1)' })
  async generateProjectReport(
    @Body() dto: ReportDto,
    @Request() req: RequestWithUser,
  ) {
    if (dto.format !== 'pdf' && dto.format !== 'csv') {
      throw new BadRequestException('Report format must be pdf or csv');
    }

    if (dto.format === 'csv') {
      const csv = await this.reportsService.exportProjectCsv(
        dto.project_id,
        req.user.id,
        req.user.roles,
      );
      return this.csvFile(csv, `lime_project_scores_${dto.project_id}.csv`);
    }

    const buffer = await this.reportsService.exportProjectPdf(
      dto.project_id,
      req.user.id,
      req.user.roles,
    );
    return this.pdfFile(buffer, `lime_project_report_${dto.project_id}.pdf`);
  }

  @Get('projects/:projectId/users/:userId/pdf')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER, Role.PROJECT_MEMBER)
  @ApiOperation({
    summary: 'Export individual performance report as PDF (Legacy GET)',
  })
  async individualPdf(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Request() req: RequestWithUser,
  ) {
    const buffer = await this.reportsService.exportIndividualPdf(
      projectId,
      userId,
      req.user.id,
      req.user.roles,
    );
    return this.pdfFile(
      buffer,
      `lime_individual_report_${projectId}_${userId}.pdf`,
    );
  }

  @Get('projects/:projectId/pdf')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @ApiOperation({
    summary: 'Export project-wide performance report as PDF (Legacy GET)',
  })
  async projectPdf(
    @Param('projectId') projectId: string,
    @Request() req: RequestWithUser,
  ) {
    const buffer = await this.reportsService.exportProjectPdf(
      projectId,
      req.user.id,
      req.user.roles,
    );
    return this.pdfFile(buffer, `lime_project_report_${projectId}.pdf`);
  }

  @Get('projects/:projectId/csv')
  @Roles(Role.DEPARTMENT_MANAGER, Role.PROJECT_MANAGER)
  @ApiOperation({
    summary: 'Export project-wide performance scores as CSV (Legacy GET)',
  })
  async projectCsv(
    @Param('projectId') projectId: string,
    @Request() req: RequestWithUser,
  ) {
    const csv = await this.reportsService.exportProjectCsv(
      projectId,
      req.user.id,
      req.user.roles,
    );
    return this.csvFile(csv, `lime_project_scores_${projectId}.csv`);
  }

  private pdfFile(buffer: Buffer, filename: string) {
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${this.safeFilename(filename)}"`,
    });
  }

  private csvFile(csv: string, filename: string) {
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${this.safeFilename(filename)}"`,
    });
  }

  private safeFilename(filename: string) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  }
}
