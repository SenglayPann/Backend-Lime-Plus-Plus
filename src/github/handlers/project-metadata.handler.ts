import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Project Metadata Handler (spec §9)
 *
 * Handles projects_v2 events for project-level metadata sync
 *
 * Purpose:
 *   - Sync project title from GitHub
 *   - Detect project deletion → soft-delete + archive
 *   - Handle project close/archive
 */
@Injectable()
export class ProjectMetadataHandler {
  private readonly logger = new Logger(ProjectMetadataHandler.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Main entry point for projects_v2 webhook events
   */
  async handle(payload: any): Promise<void> {
    const { action, projects_v2, sender } = payload;

    if (!projects_v2) {
      this.logger.warn('Invalid projects_v2 payload: missing required fields');
      return;
    }

    this.logger.log(`Project metadata ${action}: node_id=${projects_v2.node_id}`);

    // Find the project by external project ID
    const project = await this.prisma.project.findFirst({
      where: { externalProjectId: projects_v2.node_id },
    });

    if (!project) {
      this.logger.warn(`No project found for GitHub Project node ${projects_v2.node_id}`);
      return;
    }

    switch (action) {
      case 'edited':
        await this.handleEdited(project, projects_v2);
        break;
      case 'deleted':
        await this.handleDeleted(project, sender);
        break;
      case 'closed':
        await this.handleClosed(project, sender);
        break;
      default:
        this.logger.debug(`Ignoring projects_v2 action: ${action}`);
    }
  }

  /**
   * Handle project edited → sync title
   */
  private async handleEdited(project: any, projectPayload: any): Promise<void> {
    const changes: Record<string, any> = projectPayload.changes ?? {};

    if (changes.title) {
      const newTitle = changes.title.to ?? projectPayload.title;
      if (newTitle && newTitle !== project.name) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: { name: newTitle },
        });
        this.logger.log(`Project ${project.id} title synced: "${project.name}" → "${newTitle}"`);
      }
    }
  }

  /**
   * Handle project deleted → archive (spec §13: task deleted → soft-delete + flag)
   */
  private async handleDeleted(project: any, sender: any): Promise<void> {
    await this.prisma.project.update({
      where: { id: project.id },
      data: { status: 'ARCHIVED' },
    });

    // Log to audit
    if (sender) {
      const actor = await this.findOrCreateUser(
        String(sender.id),
        sender.login,
        sender.avatar_url,
      );

      await this.prisma.auditLog.create({
        data: {
          action: 'PROJECT_LOCK',
          actorId: actor.id,
          projectId: project.id,
          metadata: {
            type: 'PROJECT_DELETED_ON_GITHUB',
            previousStatus: project.status,
          },
        },
      });
    }

    this.logger.warn(`Project ${project.id} archived — GitHub Project deleted`);
  }

  /**
   * Handle project closed → lock
   */
  private async handleClosed(project: any, sender: any): Promise<void> {
    await this.prisma.project.update({
      where: { id: project.id },
      data: {
        status: 'LOCKED',
        lockedAt: new Date(),
      },
    });

    if (sender) {
      const actor = await this.findOrCreateUser(
        String(sender.id),
        sender.login,
        sender.avatar_url,
      );

      await this.prisma.auditLog.create({
        data: {
          action: 'PROJECT_LOCK',
          actorId: actor.id,
          projectId: project.id,
          metadata: {
            type: 'PROJECT_CLOSED_ON_GITHUB',
          },
        },
      });
    }

    this.logger.log(`Project ${project.id} locked — GitHub Project closed`);
  }

  /**
   * Find a user by GitHub user ID, or auto-create a minimal record
   */
  private async findOrCreateUser(
    githubUserId: string,
    login: string,
    avatarUrl?: string,
  ) {
    let user = await this.prisma.user.findUnique({
      where: { githubUserId },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          githubUserId,
          name: login,
          avatarUrl: avatarUrl ?? null,
        },
      });
    }

    return user;
  }
}
