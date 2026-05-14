import {
  collectSensitiveFieldPaths,
  expectNoSensitiveFields,
  safeUserSelect,
  sensitiveUserFieldNames,
} from './safe-user-select';

describe('safe user response serialization', () => {
  it('does not select sensitive GitHub token fields', () => {
    for (const field of sensitiveUserFieldNames) {
      expect(safeUserSelect).not.toHaveProperty(field);
    }
  });

  it('detects sensitive fields recursively in API response payloads', () => {
    const payload = {
      id: 'project-1',
      members: [
        {
          user: {
            id: 'user-1',
            githubAccessToken: 'encrypted-token',
          },
        },
      ],
    };

    expect(collectSensitiveFieldPaths(payload)).toEqual([
      'members.0.user.githubAccessToken',
    ]);
    expect(() => expectNoSensitiveFields(payload)).toThrow(
      /members\.0\.user\.githubAccessToken/,
    );
  });
});
