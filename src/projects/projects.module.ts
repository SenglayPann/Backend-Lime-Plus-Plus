import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { GitHubModule } from '../github/github.module';
import { UsersModule } from '../users/users.module';
import { ProjectAccessModule } from '../common/access/project-access.module';

@Module({
  imports: [PrismaModule, GitHubModule, UsersModule, ProjectAccessModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
