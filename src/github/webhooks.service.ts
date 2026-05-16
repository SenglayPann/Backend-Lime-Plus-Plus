import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  PrLifecycleHandler,
  PrReviewHandler,
  TaskSyncHandler,
  ProjectMetadataHandler,
  PushHandler,
} from './handlers';
import {
  GitHubPullRequestEventPayload,
  GitHubPullRequestReviewEventPayload,
  GitHubProjectV2ItemEventPayload,
  GitHubProjectV2EventPayload,
  GitHubPushEventPayload,
} from './github-payloads';

export interface WebhookEvent {
  event: string;
  deliveryId: string;
  payload: Record<string, unknown>;
}

/**
 * Webhook processing service per spec: lime_webhook_processing_flows.md
 *
 * Handles:
 *   - HMAC-SHA256 signature verification (§3.1)
 *   - Idempotency via delivery ID (§3.2)
 *   - Event routing to handlers (§4)
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private prLifecycleHandler: PrLifecycleHandler,
    private prReviewHandler: PrReviewHandler,
    private taskSyncHandler: TaskSyncHandler,
    private projectMetadataHandler: ProjectMetadataHandler,
    private pushHandler: PushHandler,
  ) {}

  /**
   * Verify GitHub webhook HMAC-SHA256 signature (spec §3.1)
   * Uses timing-safe comparison to prevent timing attacks.
   */
  verifySignature(payload: string, signature: string): boolean {
    const secret = this.configService.get<string>('GITHUB_WEBHOOK_SECRET');

    if (!secret) {
      const nodeEnv =
        this.configService.get<string>('NODE_ENV') || process.env.NODE_ENV;
      const allowUnsigned =
        this.configService.get<string>('ALLOW_UNSIGNED_WEBHOOKS') === 'true';

      if (nodeEnv === 'development' && allowUnsigned) {
        this.logger.warn(
          'GITHUB_WEBHOOK_SECRET not configured; accepting unsigned webhook because ALLOW_UNSIGNED_WEBHOOKS=true in development',
        );
        return true;
      }

      this.logger.error('GITHUB_WEBHOOK_SECRET is required for webhooks');
      return false;
    }

    if (!signature) {
      return false;
    }

    const expectedSignature =
      'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      );
    } catch {
      return false;
    }
  }

  /**
   * Check if a webhook delivery has already been processed (spec §3.2)
   */
  async isDuplicate(deliveryId: string): Promise<boolean> {
    const existing = await this.prisma.webhookDelivery.findUnique({
      where: { deliveryId },
    });
    if (!existing) return false;
    if (existing.processedAt) return true;
    if (existing.failedAt) return false;
    return Boolean(existing.queuedAt);
  }

  /**
   * Store a webhook delivery for idempotency tracking (spec §3 pipeline)
   */
  async storeDelivery(event: WebhookEvent): Promise<void> {
    await this.prisma.webhookDelivery.upsert({
      where: { deliveryId: event.deliveryId },
      update: {
        eventType: event.event,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: event.payload as any,
        failedAt: null,
        lastError: null,
      },
      create: {
        deliveryId: event.deliveryId,
        platform: 'GITHUB',
        eventType: event.event,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: event.payload as any,
      },
    });
  }

  async markQueued(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { deliveryId },
      data: { queuedAt: new Date(), failedAt: null, lastError: null },
    });
  }

  async markProcessingStarted(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { deliveryId },
      data: { processingStartedAt: new Date(), failedAt: null, lastError: null },
    });
  }

  /**
   * Mark a webhook delivery as processed
   */
  async markProcessed(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { deliveryId },
      data: { processedAt: new Date(), failedAt: null, lastError: null },
    });
  }

  async markFailed(deliveryId: string, error: unknown): Promise<void> {
    const message =
      error instanceof Error ? error.message : 'Unknown webhook processing error';

    await this.prisma.webhookDelivery.update({
      where: { deliveryId },
      data: {
        failedAt: new Date(),
        lastError: message,
      },
    });
  }

  /**
   * Route webhook events to the appropriate handler (spec §4)
   */
  async routeEvent(event: WebhookEvent): Promise<void> {
    this.logger.log(
      `Processing ${event.event} event (delivery: ${event.deliveryId})`,
    );

    switch (event.event) {
      case 'pull_request':
        await this.prLifecycleHandler.handle(
          event.payload as unknown as GitHubPullRequestEventPayload,
        );
        break;
      case 'pull_request_review':
        await this.prReviewHandler.handle(
          event.payload as unknown as GitHubPullRequestReviewEventPayload,
        );
        break;
      case 'projects_v2_item':
        await this.taskSyncHandler.handle(
          event.payload as unknown as GitHubProjectV2ItemEventPayload,
        );
        break;
      case 'projects_v2':
        await this.projectMetadataHandler.handle(
          event.payload as unknown as GitHubProjectV2EventPayload,
        );
        break;
      case 'push':
        await this.pushHandler.handle(
          event.payload as unknown as GitHubPushEventPayload,
        );
        break;
      case 'ping':
        this.logger.log(
          'Received ping event — webhook is configured correctly',
        );
        break;
      default:
        this.logger.warn(`Unhandled event type: ${event.event}`);
    }
  }
}
