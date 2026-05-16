import { Prisma } from '../generated/prisma';

export function normalizeRepositoryFullName(repository: string): string {
  const trimmed = repository.trim();
  const match = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);

  if (!match) return trimmed;

  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

export function repositoryProjectWhere(
  repository: string,
  githubRepositoryId?: string | number | null,
): Prisma.ProjectWhereInput {
  const repositoryNameMatch: Prisma.ProjectWhereInput = {
    repository: {
      equals: normalizeRepositoryFullName(repository),
      mode: 'insensitive',
    },
  };

  if (!githubRepositoryId) {
    return repositoryNameMatch;
  }

  return {
    OR: [
      { githubRepositoryId: String(githubRepositoryId) },
      repositoryNameMatch,
    ],
  };
}
