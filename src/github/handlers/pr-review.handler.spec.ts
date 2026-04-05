jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PrReviewHandler } from './pr-review.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';

describe('PrReviewHandler', () => {
  let handler: PrReviewHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
    pullRequest: { findUnique: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    prReview: { create: jest.fn() },
    contributionEvent: { create: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrReviewHandler,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    handler = module.get<PrReviewHandler>(PrReviewHandler);
    jest.clearAllMocks();
    
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  const validPayload = {
    action: 'submitted',
    review: {
      state: 'approved',
      user: { id: 2, login: 'reviewer' },
    },
    pull_request: {
      number: 1,
      user: { id: 1 }, // PR author
    },
    repository: { full_name: 'test/repo' },
  };

  it('should ignore non-submitted reviews', async () => {
    await handler.handle({ ...validPayload, action: 'edited' });
    expect(mockPrismaService.project.findFirst).not.toHaveBeenCalled();
  });

  it('should ignore self-reviews', async () => {
    const payload = JSON.parse(JSON.stringify(validPayload));
    payload.review.user.id = 1; // reviewer is author
    await handler.handle(payload);
    expect(mockPrismaService.project.findFirst).not.toHaveBeenCalled();
  });

  it('should emit PR_REVIEW_APPROVED for approved reviews', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.pullRequest.findUnique.mockResolvedValue({ id: 'pr1' });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u2' });

    await handler.handle(validPayload);

    expect(mockPrismaService.prReview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: 'APPROVED' })
    }));
    
    expect(mockPrismaService.contributionEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'PR_REVIEW_APPROVED', score: 3 })
    }));
  });

  it('should NOT emit contribution for commented reviews', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.pullRequest.findUnique.mockResolvedValue({ id: 'pr1' });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u2' });

    const payload = JSON.parse(JSON.stringify(validPayload));
    payload.review.state = 'commented';

    await handler.handle(payload);

    expect(mockPrismaService.prReview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: 'COMMENTED' })
    }));

    expect(mockPrismaService.contributionEvent.create).not.toHaveBeenCalled();
  });
});
