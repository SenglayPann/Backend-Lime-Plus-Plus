import { Module } from '@nestjs/common';
import { ScoringService } from './scoring.service';
import { ScoringController } from './scoring.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectAccessModule } from '../common/access/project-access.module';

@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [ScoringController],
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
