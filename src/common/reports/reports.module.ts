import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { PdfService } from './pdf.service';
import { ProjectAccessModule } from '../access/project-access.module';

@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [ReportsController],
  providers: [ReportsService, PdfService],
  exports: [ReportsService, PdfService],
})
export class ReportsModule {}
