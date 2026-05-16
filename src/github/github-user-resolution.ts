import { PrismaService } from '../prisma/prisma.service';
import { User } from '../generated/prisma';

type GitHubUserIdentity = {
  githubUserId: string;
  login: string;
  avatarUrl?: string | null;
};

function isNumericGitHubId(value: string) {
  return /^\d+$/.test(value);
}

export async function findOrCreateGitHubUser(
  prisma: PrismaService,
  identity: GitHubUserIdentity,
): Promise<User> {
  const byId = await prisma.user.findUnique({
    where: { githubUserId: identity.githubUserId },
  });

  if (byId) {
    const loginOwner = await prisma.user.findUnique({
      where: { githubUsername: identity.login },
    });

    return updateGitHubUserProfile(
      prisma,
      byId,
      identity,
      false,
      Boolean(loginOwner && loginOwner.id !== byId.id),
    );
  }

  const byLogin = await prisma.user.findUnique({
    where: { githubUsername: identity.login },
  });

  if (byLogin) {
    const shouldPromoteToNumericId =
      isNumericGitHubId(identity.githubUserId) &&
      !isNumericGitHubId(byLogin.githubUserId);

    return updateGitHubUserProfile(
      prisma,
      byLogin,
      identity,
      shouldPromoteToNumericId,
      false,
    );
  }

  return prisma.user.create({
    data: {
      githubUserId: identity.githubUserId,
      githubUsername: identity.login,
      name: identity.login,
      avatarUrl: identity.avatarUrl ?? null,
    },
  });
}

async function updateGitHubUserProfile(
  prisma: PrismaService,
  user: User,
  identity: GitHubUserIdentity,
  updateGitHubUserId: boolean,
  skipUsernameUpdate: boolean,
) {
  const data = {
    ...(updateGitHubUserId ? { githubUserId: identity.githubUserId } : {}),
    ...(!skipUsernameUpdate && user.githubUsername !== identity.login
      ? { githubUsername: identity.login }
      : {}),
    ...(identity.avatarUrl && user.avatarUrl !== identity.avatarUrl
      ? { avatarUrl: identity.avatarUrl }
      : {}),
    ...(!user.name ? { name: identity.login } : {}),
  };

  if (
    Object.keys(data).length === 0 ||
    typeof prisma.user.update !== 'function'
  ) {
    return user;
  }

  return prisma.user.update({
    where: { id: user.id },
    data,
  });
}
