import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { createHmac, timingSafeEqual } from 'crypto';

export interface WebhookEvent {
  event: string;
  deliveryId: string;
  payload: any;
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
  ) {}

  /**
   * Verify GitHub webhook HMAC-SHA256 signature (spec §3.1)
   * Uses timing-safe comparison to prevent timing attacks.
   */
  verifySignature(payload: string, signature: string): boolean {
    const secret = this.configService.get<string>('GITHUB_WEBHOOK_SECRET');

    if (!secret) {
      this.logger.warn('GITHUB_WEBHOOK_SECRET not configured, skipping verification');
      return true; // Allow in dev if no secret configured
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
    return existing !== null;
  }

  /**
   * Store a webhook delivery for idempotency tracking (spec §3 pipeline)
   */
  async storeDelivery(event: WebhookEvent): Promise<void> {
    await this.prisma.webhookDelivery.create({
      data: {
        deliveryId: event.deliveryId,
        platform: 'GITHUB',
        eventType: event.event,
        payload: event.payload,
      },
    });
  }

  /**
   * Mark a webhook delivery as processed
   */
  async markProcessed(deliveryId: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { deliveryId },
      data: { processedAt: new Date() },
    });
  }

  /**
   * Route webhook events to the appropriate handler (spec §4)
   *
   * Event Routing Matrix:
   *   pull_request       → PR Lifecycle Handler (§5, §6)
   *   pull_request_review → PR Review Handler (§7)
   *   projects_v2_item   → Task Sync Handler (§8)
   *   projects_v2        → Project Metadata Handler (§9)
   *   push               → Commit Metadata Handler (§10)
   *   ping               → Acknowledge
   */
  async routeEvent(event: WebhookEvent): Promise<void> {
    this.logger.log(`Processing ${event.event} event (delivery: ${event.deliveryId})`);

    switch (event.event) {
      case 'pull_request':
        await this.handlePullRequest(event.payload);
        break;
      case 'pull_request_review':
        await this.handlePullRequestReview(event.payload);
        break;
      case 'projects_v2_item':
        await this.handleProjectItem(event.payload);
        break;
      case 'projects_v2':
        await this.handleProjectMetadata(event.payload);
        break;
      case 'push':
        await this.handlePush(event.payload);
        break;
      case 'ping':
        this.logger.log('Received ping event — webhook is configured correctly');
        break;
      default:
        this.logger.warn(`Unhandled event type: ${event.event}`);
    }
  }

  /**
   * Handle pull_request events (spec §5, §6)
   *
   * Processing:
   *   Extract PR metadata → Parse task ID from title/body →
   *   Validate task exists & belongs to project →
   *   Validate PR author == task assignee →
   *   Persist PR record → If merged → emit contribution event
   *
   * Full implementation in Phase 5.
   */
  private async handlePullRequest(payload: any): Promise<void> {
    const { action, pull_request, repository } = payload;
    this.logger.log(
      `PR ${action}: #${pull_request.number} "${pull_request.title}" in ${repository.full_name}`,
    );
    // Phase 5: task ID parsing, author validation, PR persistence, contribution events
  }

  /**
   * Handle pull_request_review events (spec §7)
   *
   * Processing:
   *   Verify reviewer != PR author →
   *   Persist review record →
   *   If APPROVED → emit contribution_event →
   *   Update reviewer score
   *
   * Full implementation in Phase 5.
   */
  private async handlePullRequestReview(payload: any): Promise<void> {
    const { action, review, pull_request, repository } = payload;
    this.logger.log(
      `Review ${action}: ${review.state} on PR #${pull_request.number} in ${repository.full_name}`,
    );
    // Phase 5: reviewer validation, review persistence, contribution events
  }

  /**
   * Handle projects_v2_item events (spec §8)
   *
   * Processing:
   *   Extract item & field changes →
   *   Map to Lime++ task →
   *   Create or update task →
   *   Sync status & assignee
   *
   * Strict rules:
   *   - Task ID generated and immutable
   *   - Assignee change logged in audit_logs
   *   - Task reassignment after PR opened → FLAG
   *
   * Full implementation in Phase 5.
   */
  private async handleProjectItem(payload: any): Promise<void> {
    const { action } = payload;
    this.logger.log(`Project item ${action}`);
    // Phase 5: task sync, status mapping, assignee sync
  }

  /**
   * Handle projects_v2 events (spec §9)
   *
   * Purpose:
   *   - Sync project title
   *   - Detect project deletion
   *   - Handle project archive
   *
   * Full implementation in Phase 5.
   */
  private async handleProjectMetadata(payload: any): Promise<void> {
    const { action } = payload;
    this.logger.log(`Project metadata ${action}`);
    // Phase 5: project title sync, deletion handling, archive handling
  }

  /**
   * Handle push events (spec §10)
   *
   * Purpose (supporting evidence only, NOT used for scoring):
   *   - Attach commit metadata to PRs
   *   - Timeline visualization
   *
   * Full implementation in Phase 5.
   */
  private async handlePush(payload: any): Promise<void> {
    const { ref, repository, commits } = payload;
    const commitCount = commits?.length ?? 0;
    this.logger.log(
      `Push to ${ref} in ${repository.full_name}: ${commitCount} commit(s)`,
    );
    // Phase 5: commit metadata persistence, PR linkage (no scoring)
  }
}
