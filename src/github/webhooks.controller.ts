import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WebhooksService } from './webhooks.service';

/**
 * Webhook receiver per spec: lime_webhook_processing_flows.md §2–§3
 *
 * Pipeline:
 *   GitHub → Verify HMAC → Idempotency Check → Persist Raw Payload → Async Job Queue
 *
 * Endpoint: POST /api/webhooks/github
 *   (spec says /api/webhooks/github, NOT /api/v1/webhooks/github)
 */
@Controller('api/webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  /** Max payload size: 5 MB (spec §3.1) */
  private readonly MAX_PAYLOAD_SIZE = 5 * 1024 * 1024;

  constructor(
    private webhooksService: WebhooksService,
    @InjectQueue('webhook-events') private webhookQueue: Queue,
  ) {}

  @Post('github')
  @HttpCode(HttpStatus.OK)
  async handleGitHubWebhook(
    @Headers('x-github-event') event: string,
    @Headers('x-github-delivery') deliveryId: string,
    @Headers('x-hub-signature-256') signature: string,
    @Req() req: any,
  ) {
    // 1. Validate required headers (spec §2)
    if (!event || !deliveryId) {
      throw new BadRequestException('Missing required GitHub webhook headers');
    }

    // 2. Get raw body for signature verification
    const rawBody: Buffer | undefined = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException('Raw body not available for signature verification');
    }

    // 3. Reject if payload size exceeds limit (spec §3.1)
    if (rawBody.length > this.MAX_PAYLOAD_SIZE) {
      throw new PayloadTooLargeException(
        `Payload size ${rawBody.length} exceeds maximum ${this.MAX_PAYLOAD_SIZE}`,
      );
    }

    const rawBodyString = rawBody.toString('utf8');

    // 4. Verify HMAC signature (spec §3.1)
    const isValid = this.webhooksService.verifySignature(rawBodyString, signature);
    if (!isValid) {
      this.logger.warn(`Invalid webhook signature for delivery ${deliveryId}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 5. Idempotency check (spec §3.2)
    const isDuplicate = await this.webhooksService.isDuplicate(deliveryId);
    if (isDuplicate) {
      this.logger.log(`Duplicate delivery ${deliveryId}, skipping`);
      return { status: 'duplicate', deliveryId };
    }

    // 6. Persist raw payload (spec §3 pipeline step)
    const payload = JSON.parse(rawBodyString);
    await this.webhooksService.storeDelivery({ event, deliveryId, payload });

    // 7. Enqueue to async job queue (spec §3 pipeline step)
    await this.webhookQueue.add('process-webhook', {
      event,
      deliveryId,
      payload,
    });

    this.logger.log(`Webhook ${event} (delivery: ${deliveryId}) enqueued for processing`);
    return { status: 'accepted', deliveryId };
  }
}
