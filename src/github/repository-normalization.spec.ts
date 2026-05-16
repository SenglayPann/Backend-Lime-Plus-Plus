import {
  normalizeRepositoryFullName,
  repositoryProjectWhere,
} from './repository-normalization';

describe('repository normalization', () => {
  it('normalizes owner/repo names for storage', () => {
    expect(normalizeRepositoryFullName(' Owner/Repo ')).toBe('owner/repo');
  });

  it('builds a case-insensitive project lookup', () => {
    expect(repositoryProjectWhere('Owner/Repo')).toEqual({
      repository: {
        equals: 'owner/repo',
        mode: 'insensitive',
      },
    });
  });

  it('matches GitHub repository ID before name fallback when available', () => {
    expect(repositoryProjectWhere('Owner/Renamed', 123)).toEqual({
      OR: [
        { githubRepositoryId: '123' },
        {
          repository: {
            equals: 'owner/renamed',
            mode: 'insensitive',
          },
        },
      ],
    });
  });
});
