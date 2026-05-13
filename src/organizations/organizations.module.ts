import { Module } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectAccessModule } from '../common/access/project-access.module';

@Module({
  imports: [PrismaModule, ProjectAccessModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
