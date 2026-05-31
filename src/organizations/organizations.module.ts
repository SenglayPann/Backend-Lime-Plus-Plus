import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { EnrollmentService } from './enrollment.service';
import { ContributorVerificationService } from './contributor-verification.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectAccessModule } from '../common/access/project-access.module';

@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    EnrollmentService,
    ContributorVerificationService,
  ],
  exports: [
    OrganizationsService,
    EnrollmentService,
    ContributorVerificationService,
  ],
})
export class OrganizationsModule {}
