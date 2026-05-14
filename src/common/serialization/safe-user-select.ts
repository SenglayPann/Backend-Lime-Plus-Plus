export const sensitiveUserFieldNames = [
  'githubAccessToken',
  'githubTokenUpdatedAt',
] as const;

export const safeUserSelect = {
  id: true,
  githubUserId: true,
  githubUsername: true,
  email: true,
  name: true,
  avatarUrl: true,
  createdAt: true,
} as const;

export function collectSensitiveFieldPaths(
  value: unknown,
  path: string[] = [],
): string[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectSensitiveFieldPaths(item, [...path, String(index)]),
    );
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => {
      const childPath = [...path, key];
      const nestedPaths = collectSensitiveFieldPaths(child, childPath);

      if ((sensitiveUserFieldNames as readonly string[]).includes(key)) {
        return [childPath.join('.'), ...nestedPaths];
      }

      return nestedPaths;
    },
  );
}

export function expectNoSensitiveFields(value: unknown): void {
  const sensitivePaths = collectSensitiveFieldPaths(value);

  if (sensitivePaths.length > 0) {
    throw new Error(
      `Sensitive fields found in response: ${sensitivePaths.join(', ')}`,
    );
  }
}
