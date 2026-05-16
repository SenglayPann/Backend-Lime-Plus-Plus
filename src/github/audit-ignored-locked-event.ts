import { AuditAction, Project } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubUserPayload } from './github-payloads';
import { findOrCreateGitHubUser } from './github-user-resolution';

export async function auditIgnoredLockedWebhook(
  prisma: PrismaService,
  project: Project,
  sender: GitHubUserPayload | undefined,
  metadata: Record<string, unknown>,
) {
  if (!sender) return;

  const actor = await findOrCreateGitHubUser(prisma, {
    githubUserId: String(sender.id),
    login: sender.login,
    avatarUrl: sender.avatar_url,
  });

  await prisma.auditLog.create({
    data: {
      action: AuditAction.WEBHOOK_IGNORED,
      actorId: actor.id,
      projectId: project.id,
      metadata: {
        reason: 'PROJECT_LOCKED',
        ...metadata,
      },
    },
  });
}
