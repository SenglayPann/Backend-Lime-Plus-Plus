import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { WebhooksService, WebhookEvent } from './webhooks.service';

/**
 * BullMQ processor for webhook events (spec §3 pipeline: Async Job Queue)
 *
 * Consumes jobs from the 'webhook-events' queue and routes them
 * to the appropriate handler via WebhooksService.
 *
 * Marks the delivery as processed after successful handling.
 */
@Processor('webhook-events')
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private webhooksService: WebhooksService) {
    super();
  }

  async process(job: Job<WebhookEvent>): Promise<void> {
    const { event, deliveryId, payload } = job.data;

    this.logger.log(`Processing webhook job: ${event} (delivery: ${deliveryId})`);

    try {
      await this.webhooksService.routeEvent({ event, deliveryId, payload });
      await this.webhooksService.markProcessed(deliveryId);
      this.logger.log(`Webhook ${deliveryId} processed successfully`);
    } catch (error) {
      this.logger.error(`Failed to process webhook ${deliveryId}`, error);
      throw error; // BullMQ will retry based on queue config
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<WebhookEvent> | undefined, error: Error) {
    if (!job) return;

    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      this.logger.error(
        `[DLQ] Webhook ${job.data.deliveryId} moved to DLQ after ${job.attemptsMade} attempts: ${error.message}`
      );
      // In Phase 7: emit alert to admin dashboard
    }
  }
}
