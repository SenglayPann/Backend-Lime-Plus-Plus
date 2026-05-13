import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectAccessModule } from '../access/project-access.module';

@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
