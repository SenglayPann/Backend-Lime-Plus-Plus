import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { GitHubModule } from './github/github.module';
import { ScoringModule } from './scoring/scoring.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { OrganizationsModule } from './organizations/organizations.module';
import { DepartmentsModule } from './departments/departments.module';
import { ProjectsModule } from './projects/projects.module';
import { TasksModule } from './tasks/tasks.module';
import { PullRequestsModule } from './pull-requests/pull-requests.module';
import { AuditModule } from './common/audit/audit.module';
import { ReportsModule } from './common/reports/reports.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL', 'redis://localhost:6379'),
        },
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    AuthModule,
    GitHubModule,
    ScoringModule,
    EventEmitterModule.forRoot(),
    OrganizationsModule,
    DepartmentsModule,
    ProjectsModule,
    TasksModule,
    PullRequestsModule,
    AuditModule,
    ReportsModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
