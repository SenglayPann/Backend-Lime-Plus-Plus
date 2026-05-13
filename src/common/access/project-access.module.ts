import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { DepartmentAccessService } from './department-access.service';
import { OrganizationAccessService } from './organization-access.service';
import { ProjectAccessService } from './project-access.service';
import { RoleDelegationService } from './role-delegation.service';
import { UserVisibilityService } from './user-visibility.service';

@Module({
  imports: [PrismaModule],
  providers: [
    DepartmentAccessService,
    OrganizationAccessService,
    ProjectAccessService,
    RoleDelegationService,
    UserVisibilityService,
  ],
  exports: [
    DepartmentAccessService,
    OrganizationAccessService,
    ProjectAccessService,
    RoleDelegationService,
    UserVisibilityService,
  ],
})
export class ProjectAccessModule {}
