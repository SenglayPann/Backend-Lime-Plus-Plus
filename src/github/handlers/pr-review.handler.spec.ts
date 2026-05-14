jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest
    .fn()
    .mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PrReviewHandler } from './pr-review.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GitHubPullRequestReviewEventPayload } from '../github-payloads';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';

describe('PrReviewHandler', () => {
  let handler: PrReviewHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
    pullRequest: { findUnique: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    prReview: { create: jest.fn(), upsert: jest.fn() },
    contributionEvent: { create: jest.fn(), upsert: jest.fn() },
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };
  const mockProjectLockGuard = {
    isLocked: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrReviewHandler,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuard },
      ],
    }).compile();

    handler = module.get<PrReviewHandler>(PrReviewHandler);
    jest.clearAllMocks();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    mockProjectLockGuard.isLocked.mockReturnValue(false);
  });

  const validPayload: GitHubPullRequestReviewEventPayload = {
    action: 'submitted',
    review: {
      id: 123,
      node_id: 'node-123',
      user: { id: 2, login: 'reviewer' },
      body: 'Good job',
      state: 'approved',
      html_url: 'http://github.com/review',
      pull_request_url: 'http://github.com/pr',
      submitted_at: new Date().toISOString(),
      commit_id: 'abc',
      author_association: 'MEMBER',
    },
    pull_request: {
      number: 1,
      user: { id: 1, login: 'author' }, // PR author
    },
    repository: { full_name: 'test/repo' },
  } as unknown as GitHubPullRequestReviewEventPayload;

  it('should ignore non-submitted reviews', async () => {
    await handler.handle({ ...validPayload, action: 'edited' });
    expect(mockPrismaService.project.findFirst).not.toHaveBeenCalled();
  });

  it('should ignore self-reviews', async () => {
    const payload = {
      ...validPayload,
      review: {
        ...validPayload.review,
        user: { ...validPayload.review.user, id: 1 },
      },
    } as GitHubPullRequestReviewEventPayload;

    await handler.handle(payload);
    expect(mockPrismaService.project.findFirst).not.toHaveBeenCalled();
  });

  it('should emit PR_REVIEW_APPROVED for approved reviews', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.pullRequest.findUnique.mockResolvedValue({ id: 'pr1' });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u2' });
    mockPrismaService.prReview.upsert.mockResolvedValue({ id: 'r1' });

    await handler.handle(validPayload);

    expect(mockPrismaService.prReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          externalReviewId: '123',
          state: 'APPROVED',
        }) as unknown,
      }),
    );

    expect(mockPrismaService.contributionEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: 'PR_REVIEW_APPROVED',
          referenceId: 'r1',
          score: 3,
        }) as unknown,
      }),
    );
  });

  it('should NOT emit contribution for commented reviews', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.pullRequest.findUnique.mockResolvedValue({ id: 'pr1' });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u2' });
    mockPrismaService.prReview.upsert.mockResolvedValue({ id: 'r1' });

    const payload = {
      ...validPayload,
      review: {
        ...validPayload.review,
        state: 'commented',
      },
    } as GitHubPullRequestReviewEventPayload;

    await handler.handle(payload);

    expect(mockPrismaService.prReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ state: 'COMMENTED' }) as unknown,
      }),
    );

    expect(mockPrismaService.contributionEvent.upsert).not.toHaveBeenCalled();
  });
});
