import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

// Mock @octokit/graphql before importing GitHubService (ESM module)
jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

// Mock @octokit/auth-app
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { GitHubService } from './github.service';

describe('GitHubService', () => {
  let service: GitHubService;

  beforeEach(async () => {
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
});
