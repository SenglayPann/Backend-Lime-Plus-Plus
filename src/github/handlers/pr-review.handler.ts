import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GitHubPullRequestReviewEventPayload } from '../github-payloads';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';
import { repositoryProjectWhere } from '../repository-normalization';
import { auditIgnoredLockedWebhook } from '../audit-ignored-locked-event';
import { findOrCreateGitHubUser } from '../github-user-resolution';
import type { ProjectUpdatePayload } from '../project-events.service';

/**
 * PR Review Handler (spec §7)
 *
 * Handles pull_request_review events (submitted action only)
 *
 * Processing pipeline:
 *   Verify reviewer ≠ PR author → Persist review record →
 *   If APPROVED → emit contribution_event
 *
 * Rules:
 *   - Self-reviews are silently skipped
 *   - Comment-only reviews tracked but no contribution event
 *   - Review score capped per PR (enforced in Phase 6 scoring)
 */
@Injectable()
export class PrReviewHandler {
  private readonly logger = new Logger(PrReviewHandler.name);

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private projectLockGuard: ProjectLockGuardService,
  ) {}

  /**
   * Main entry point for pull_request_review webhook events
   */
  async handle(payload: GitHubPullRequestReviewEventPayload): Promise<void> {
    const { action, review, pull_request, repository } = payload;

    if (!review || !pull_request || !repository) {
      this.logger.warn(
        'Invalid pull_request_review payload: missing required fields',
      );
      return;
    }

    // Only process submitted reviews
    if (action !== 'submitted') {
      this.logger.debug(`Ignoring review action: ${action}`);
      return;
    }

    this.logger.log(
      `Review ${review.state} on PR #${pull_request.number} by ${review.user.login} in ${repository.full_name}`,
    );

    // Self-review check: reviewer must not be PR author
    if (review.user.id === pull_request.user.id) {
      this.logger.debug(
        `Skipping self-review by ${review.user.login} on PR #${pull_request.number}`,
      );
      return;
    }

    // Find the project
    const project = await this.prisma.project.findFirst({
      where: repositoryProjectWhere(repository.full_name, repository.id),
    });

    if (!project) {
      this.logger.warn(
        `No project found for repository ${repository.full_name}`,
      );
      return;
    }

    if (this.projectLockGuard.isLocked(project)) {
      this.logger.warn(
        `Ignoring pull_request_review ${action} for locked project ${project.id}`,
      );
      await auditIgnoredLockedWebhook(this.prisma, project, payload.sender, {
        event: 'pull_request_review',
        action,
        repository: repository.full_name,
        pullRequestNumber: pull_request.number,
        reviewId: review.id,
      });
      return;
    }

    // Find the PR in our DB
    const existingPr = await this.prisma.pullRequest.findUnique({
      where: {
        projectId_externalPrId: {
          projectId: project.id,
          externalPrId: String(pull_request.number),
        },
      },
    });

    if (!existingPr) {
      this.logger.warn(
        `PR #${pull_request.number} not found in DB — review cannot be linked`,
      );
      return;
    }

    // Find or create the reviewer user
    const reviewer = await this.findOrCreateUser(
      String(review.user.id),
      review.user.login,
      review.user.avatar_url,
    );

    // Map GitHub review state to our enum
    const reviewState = this.mapReviewState(review.state);

    // Persist review record
    const externalReviewId = String(review.id);
    const savedReview = await this.prisma.prReview.upsert({
      where: {
        pullRequestId_externalReviewId: {
          pullRequestId: existingPr.id,
          externalReviewId,
        },
      },
      create: {
        pullRequestId: existingPr.id,
        externalReviewId,
        reviewerId: reviewer.id,
        state: reviewState,
        body: review.body ?? null,
      },
      update: {
        reviewerId: reviewer.id,
        state: reviewState,
        body: review.body ?? null,
      },
    });

    this.logger.log(
      `Review persisted: ${reviewState} on PR #${pull_request.number} by ${review.user.login}`,
    );
    const projectUpdate: ProjectUpdatePayload = {
      projectId: project.id,
      kind: 'pr_review',
      at: new Date().toISOString(),
    };
    this.eventEmitter.emit('project.updated', projectUpdate);

    // Emit contribution event only for APPROVED reviews
    if (reviewState === 'APPROVED') {
      await this.prisma.contributionEvent.upsert({
        where: {
          projectId_userId_type_referenceId: {
            projectId: project.id,
            userId: reviewer.id,
            type: 'PR_REVIEW_APPROVED',
            referenceId: savedReview.id,
          },
        },
        create: {
          projectId: project.id,
          userId: reviewer.id,
          type: 'PR_REVIEW_APPROVED',
          referenceId: savedReview.id,
          score: 3,
        },
        update: { score: 3 },
      });

      this.logger.log(
        `Contribution event emitted: PR_REVIEW_APPROVED(+3) for ${review.user.login}`,
      );
      this.eventEmitter.emit('contribution.created', { projectId: project.id });
    }
  }

  /**
   * Map GitHub review state string to our ReviewState enum
   */
  private mapReviewState(
    state: string,
  ): 'APPROVED' | 'COMMENTED' | 'CHANGES_REQUESTED' {
    switch (state.toLowerCase()) {
      case 'approved':
        return 'APPROVED';
      case 'changes_requested':
        return 'CHANGES_REQUESTED';
      case 'commented':
      default:
        return 'COMMENTED';
    }
  }

  /**
   * Find a user by GitHub user ID, or auto-create a minimal record
   */
  private async findOrCreateUser(
    githubUserId: string,
    login: string,
    avatarUrl?: string,
  ) {
    return findOrCreateGitHubUser(this.prisma, {
      githubUserId,
      login,
      avatarUrl,
    });
  }
}
