import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Push Event Handler (spec §10)
 *
 * Handles push events for commit metadata (supporting evidence only)
 *
 * Purpose:
 *   - Log commit metadata for timeline visualization
 *   - Attach commit info to the webhook delivery payload
 *   - NOT used for scoring
 *
 * Per spec §10 and strict mode rules:
 *   - Direct commits to main are NOT scored
 *   - Commit count is NOT used for scoring (easily gamed)
 *   - Push data is purely supporting evidence
 */
@Injectable()
export class PushHandler {
  private readonly logger = new Logger(PushHandler.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Main entry point for push webhook events
   */
  async handle(payload: any): Promise<void> {
    const { ref, repository, commits, sender, before, after } = payload;

    if (!repository) {
      this.logger.warn('Invalid push payload: missing repository');
      return;
    }

    const commitCount = commits?.length ?? 0;
    const branch = ref?.replace('refs/heads/', '') ?? 'unknown';

    this.logger.log(
      `Push to ${branch} in ${repository.full_name}: ${commitCount} commit(s) by ${sender?.login ?? 'unknown'}`,
    );

    // Find the project (optional — push events are supporting only)
    const project = await this.prisma.project.findFirst({
      where: { repository: repository.full_name },
    });

    if (!project) {
      this.logger.debug(`No project found for repository ${repository.full_name} — push logged but not tracked`);
      return;
    }

    // Log commit summary for observability
    if (commits && commits.length > 0) {
      for (const commit of commits.slice(0, 10)) {
        this.logger.debug(
          `  Commit ${commit.id?.substring(0, 7)}: "${commit.message?.split('\n')[0]}" by ${commit.author?.username ?? commit.author?.name ?? 'unknown'}`,
        );
      }

      if (commits.length > 10) {
        this.logger.debug(`  ... and ${commits.length - 10} more commit(s)`);
      }
    }

    // No database writes or contribution events
    // Commit data is already stored in the webhook_deliveries payload
    // Timeline visualization will query webhook_deliveries for push events
  }
}
