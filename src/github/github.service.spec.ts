import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { graphql } from '@octokit/graphql';

// Mock @octokit/graphql before importing GitHubService (ESM module)
jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

// Mock @octokit/auth-app
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest
    .fn()
    .mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { GitHubService } from './github.service';

describe('GitHubService', () => {
  let service: GitHubService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitHubService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GitHubService>(GitHubService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should have getRepositoryPRs method', () => {
    expect(typeof service.getRepositoryPRs).toBe('function');
  });

  it('should have getPullRequest method', () => {
    expect(typeof service.getPullRequest).toBe('function');
  });

  it('should have getProjectItems method', () => {
    expect(typeof service.getProjectItems).toBe('function');
  });

  it('should paginate Project V2 items until the cursor is exhausted', async () => {
    const client = jest
      .fn()
      .mockResolvedValueOnce({
        node: {
          items: {
            nodes: [{ id: 'item-1' }],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          items: {
            nodes: [{ id: 'item-2' }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    (graphql.defaults as jest.Mock).mockReturnValue(client);

    const result = await service.getProjectItems('project-id', 'token');

    expect(result).toEqual([{ id: 'item-1' }, { id: 'item-2' }]);
    expect(client).toHaveBeenNthCalledWith(1, expect.any(String), {
      projectId: 'project-id',
      first: 100,
      after: null,
    });
    expect(client).toHaveBeenNthCalledWith(2, expect.any(String), {
      projectId: 'project-id',
      first: 100,
      after: 'cursor-1',
    });
  });
});
