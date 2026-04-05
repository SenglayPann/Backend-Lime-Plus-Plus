import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GitHubService } from './github.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookProcessor } from './webhook.processor';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: 'webhook-events',
    }),
  ],
  controllers: [WebhooksController],
  providers: [GitHubService, WebhooksService, WebhookProcessor],
  exports: [GitHubService, WebhooksService],
})
export class GitHubModule {}
