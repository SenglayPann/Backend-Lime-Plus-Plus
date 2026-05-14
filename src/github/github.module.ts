import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GitHubService } from './github.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookProcessor } from './webhook.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { ProjectAccessModule } from '../common/access/project-access.module';
import {
  PrLifecycleHandler,
  PrReviewHandler,
  TaskSyncHandler,
  ProjectMetadataHandler,
  PushHandler,
} from './handlers';

@Module({
  imports: [
    PrismaModule,
    ProjectAccessModule,
    BullModule.registerQueue({
      name: 'webhook-events',
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [WebhooksController],
  providers: [
    GitHubService,
    WebhooksService,
    WebhookProcessor,
    PrLifecycleHandler,
    PrReviewHandler,
    TaskSyncHandler,
    ProjectMetadataHandler,
    PushHandler,
  ],
  exports: [GitHubService, WebhooksService],
})
export class GitHubModule {}
