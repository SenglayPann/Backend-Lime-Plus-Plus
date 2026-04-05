import { Test, TestingModule } from '@nestjs/testing';
import { ScoringService, DEFAULT_SCORING_CONFIG } from './scoring.service';
import { PrismaService } from '../prisma/prisma.service';
import { Logger } from '@nestjs/common';

describe('ScoringService', () => {
  let service: ScoringService;

  const mockPrismaService = {
    project: { findUnique: jest.fn() },
    task: { findMany: jest.fn() },
    prReview: { findMany: jest.fn() },
    scoreOverride: { findMany: jest.fn(), create: jest.fn() },
    contributionScore: { upsert: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScoringService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<ScoringService>(ScoringService);
    jest.clearAllMocks();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  describe('calculateProjectScores', () => {
    it('should skip calculation for locked projects', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({ id: 'p1', status: 'LOCKED' });
      await service.calculateProjectScores('p1');
      expect(mockPrismaService.task.findMany).not.toHaveBeenCalled();
    });

    it('should correctly calculate base scores and apply limits', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        scoringConfig: null,
        contributionEvents: [
          { userId: 'u1', type: 'PR_MERGED', referenceId: 't1', createdAt: new Date() },
          { userId: 'u1', type: 'TASK_COMPLETED', referenceId: 't1', createdAt: new Date() },
        ]
      });

      mockPrismaService.task.findMany.mockResolvedValue([
        { id: 't1', difficulty: 'LOW', completedAt: new Date(), dueDate: new Date() } // onTime, low diff = 1.0 * 1.0
      ]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          totalScore: 15, // 10 + 5
        })
      }));
    });

    it('should respect difficulty and timeliness multipliers', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        scoringConfig: null,
        contributionEvents: [
          { userId: 'u1', type: 'PR_MERGED', referenceId: 't1', createdAt: new Date() },
        ]
      });

      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 2); // completed early
      
      mockPrismaService.task.findMany.mockResolvedValue([
        { id: 't1', difficulty: 'HIGH', completedAt: new Date(), dueDate } 
      ]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      // PR_MERGED = 10. HIGH = 1.5. EARLY = 1.1 => 10 * 1.5 * 1.1 = 16.5 => 17
      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({
          totalScore: 17, // Math.round(16.5)
        })
      }));
    });

    it('should cap review scores per PR and globally', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        scoringConfig: null,
        contributionEvents: [
          { userId: 'u1', type: 'PR_MERGED', referenceId: 't1', createdAt: new Date() },
          { userId: 'u1', type: 'PR_REVIEW_APPROVED', referenceId: 'r1', createdAt: new Date() },
          { userId: 'u1', type: 'PR_REVIEW_APPROVED', referenceId: 'r2', createdAt: new Date() },
        ]
      });

      mockPrismaService.task.findMany.mockResolvedValue([
        { id: 't1', difficulty: 'LOW', completedAt: new Date(), dueDate: new Date() } // PR_MERGED = 10
      ]);

      mockPrismaService.prReview.findMany.mockResolvedValue([
        { id: 'r1', pullRequestId: 'pr1', pullRequest: { authorId: 'u2' } }, // Score 3
        { id: 'r2', pullRequestId: 'pr1', pullRequest: { authorId: 'u2' } }, // Same PR review. Score 3 -> Capped at 5 for this PR
      ]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      // Task = 10. Reviews for PR1 = 3 + 2 (capped at 5) = 15 total before global cap.
      // Global cap = 20% of total score. 15 * 0.20 = 3 max.
      // Wait, userScore.totalScore is 15. maxReviewAllowed = floor(15 * 0.20) = 3.
      // reviewScore = 5. deduction = 5 - 3 = 2.
      // Final total score = 15 - 2 = 13.

      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(expect.objectContaining({
        update: expect.objectContaining({
          totalScore: 13,
        })
      }));
    });
  });

  describe('applyOverride', () => {
    it('should insert override and recalculate', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({ id: 'p1', status: 'ACTIVE' });
      // To satisfy recalculate calls
      mockPrismaService.task.findMany.mockResolvedValue([]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([
        { userId: 'u1', delta: 50, reason: 'Bonus' }
      ]);
      
      const calcSpy = jest.spyOn(service, 'calculateProjectScores').mockResolvedValue();

      await service.applyOverride('p1', 'u1', 'admin1', 50, 'Bonus');

      expect(mockPrismaService.scoreOverride.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ delta: 50, reason: 'Bonus' })
      }));
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'SCORE_OVERRIDE' })
      }));
      
      expect(calcSpy).toHaveBeenCalledWith('p1');
    });
  });
});
