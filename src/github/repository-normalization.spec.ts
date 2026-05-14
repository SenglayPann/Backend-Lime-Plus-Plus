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
});
