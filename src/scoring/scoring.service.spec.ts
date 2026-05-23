import { Test, TestingModule } from '@nestjs/testing';
import { ScoringService } from './scoring.service';
import { PrismaService } from '../prisma/prisma.service';
import { Logger } from '@nestjs/common';
import { ProjectAccessService } from '../common/access/project-access.service';
import { ProjectLockGuardService } from '../common/access/project-lock-guard.service';

describe('ScoringService', () => {
  let service: ScoringService;

  const mockPrismaService = {
    project: { findUnique: jest.fn() },
    task: { findMany: jest.fn() },
    prReview: { findMany: jest.fn() },
    scoreOverride: { findMany: jest.fn(), create: jest.fn() },
    contributionScore: { upsert: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
    projectMember: { findFirst: jest.fn() },
  };

  const mockProjectAccessService = {
    assertCanManageProject: jest.fn(),
    assertCanViewProject: jest.fn(),
  };
  const mockProjectLockGuardService = {
    assertProjectMutable: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScoringService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuardService },
      ],
    }).compile();

    service = module.get<ScoringService>(ScoringService);
    jest.clearAllMocks();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    mockProjectLockGuardService.assertProjectMutable.mockResolvedValue(undefined);
  });

  describe('calculateProjectScores', () => {
    it('should skip calculation for locked projects', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'LOCKED',
      });
      await service.calculateProjectScores('p1');
      expect(mockPrismaService.task.findMany).not.toHaveBeenCalled();
    });

    it('should correctly calculate base scores and apply limits', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        scoringConfig: null,
        contributionEvents: [
          {
            userId: 'u1',
            type: 'PR_MERGED',
            referenceId: 't1',
            createdAt: new Date(),
          },
          {
            userId: 'u1',
            type: 'TASK_COMPLETED',
            referenceId: 't1',
            createdAt: new Date(),
          },
        ],
      });

      mockPrismaService.task.findMany.mockResolvedValue([
        {
          id: 't1',
          difficulty: 'LOW',
          completedAt: new Date(),
          dueDate: new Date(),
        },
      ]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            totalScore: 10,
          }) as unknown,
        }),
      );
    });

    it('should calculate scores independently for multiple users', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        scoringConfig: null,
        contributionEvents: [
          {
            userId: 'u1',
            type: 'TASK_COMPLETED',
            referenceId: 't1',
            createdAt: new Date(),
          },
          {
            userId: 'u2',
            type: 'TASK_COMPLETED',
            referenceId: 't2',
            createdAt: new Date(),
          },
        ],
      });

      mockPrismaService.task.findMany.mockResolvedValue([
        {
          id: 't1',
          difficulty: 'LOW',
          completedAt: new Date(),
          dueDate: new Date(),
        },
        {
          id: 't2',
          difficulty: 'HIGH',
          completedAt: new Date(),
          dueDate: new Date(),
        },
      ]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledTimes(
        2,
      );
      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userId: 'u1',
            totalScore: 10,
          }) as unknown,
        }),
      );
      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userId: 'u2',
            totalScore: 15,
          }) as unknown,
        }),
      );
    });

    it('creates zero-score rows for members without contributions', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        scoringConfig: null,
        members: [{ userId: 'u1' }, { userId: 'u2' }],
        contributionEvents: [
          {
            userId: 'u1',
            type: 'TASK_COMPLETED',
            referenceId: 't1',
            createdAt: new Date(),
          },
        ],
      });

      mockPrismaService.task.findMany.mockResolvedValue([
        {
          id: 't1',
          difficulty: 'LOW',
          completedAt: new Date(),
          dueDate: new Date(),
        },
      ]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            userId: 'u2',
            totalScore: 0,
          }) as unknown,
          update: expect.objectContaining({
            totalScore: 0,
          }) as unknown,
        }),
      );
    });

    it('should ignore events outside evaluation window', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      const tomorrow = new Date(now.getTime() + 86400000);

      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        evalStart: now,
        evalEnd: tomorrow,
        contributionEvents: [
          {
            userId: 'u1',
            type: 'TASK_COMPLETED',
            referenceId: 't1',
            createdAt: now,
          },
        ],
      });

      mockPrismaService.task.findMany.mockResolvedValue([
        { id: 't1', difficulty: 'LOW', completedAt: now, dueDate: now },
      ]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ totalScore: 10 }) as unknown,
        }),
      );
    });

    it('should cap review scores per PR and globally', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        scoringConfig: null,
        contributionEvents: [
          {
            userId: 'u1',
            type: 'TASK_COMPLETED',
            referenceId: 't1',
            createdAt: new Date(),
          },
          {
            userId: 'u1',
            type: 'PR_REVIEW_APPROVED',
            referenceId: 'r1',
            createdAt: new Date(),
          },
          {
            userId: 'u1',
            type: 'PR_REVIEW_APPROVED',
            referenceId: 'r2',
            createdAt: new Date(),
          },
        ],
      });

      mockPrismaService.task.findMany.mockResolvedValue([
        {
          id: 't1',
          difficulty: 'LOW',
          completedAt: new Date(),
          dueDate: new Date(),
        },
      ]);

      mockPrismaService.prReview.findMany.mockResolvedValue([
        {
          id: 'r1',
          pullRequestId: 'pr1',
          pullRequest: { authorId: 'u2', externalPrId: '1' },
        },
        {
          id: 'r2',
          pullRequestId: 'pr1',
          pullRequest: { authorId: 'u2', externalPrId: '1' },
        },
      ]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      await service.calculateProjectScores('p1');

      // Task = 10. Reviews for PR1 = 3 + 2 (capped at 5) = 15 total before global cap.
      // Global cap = 20% of total score. 15 * 0.20 = 3 max.
      // Final total score = 13.
      expect(mockPrismaService.contributionScore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ totalScore: 13 }) as unknown,
        }),
      );
    });
  });

  describe('applyOverride', () => {
    it('should insert override and recalculate', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
      });
      mockPrismaService.task.findMany.mockResolvedValue([]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);
      mockPrismaService.projectMember.findFirst.mockResolvedValue({ id: 'm1' });

      const calcSpy = jest
        .spyOn(service, 'calculateProjectScores')
        .mockResolvedValue();

      await service.applyOverride('p1', 'u1', 50, 'Bonus', 'admin1', ['ADMIN']);

      expect(
        mockProjectLockGuardService.assertProjectMutable,
      ).toHaveBeenCalledWith('p1', 'override scores');
      expect(mockPrismaService.scoreOverride.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            delta: 50,
            reason: 'Bonus',
            overriddenBy: 'admin1',
          }) as unknown,
        }),
      );
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'SCORE_OVERRIDE',
            actorId: 'admin1',
          }) as unknown,
        }),
      );

      expect(calcSpy).toHaveBeenCalledWith('p1');
    });

    it('allows project managers to apply score overrides on managed projects', async () => {
      mockProjectAccessService.assertCanManageProject.mockResolvedValue(undefined);
      mockPrismaService.projectMember.findFirst.mockResolvedValue({ id: 'm1' });
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
      });
      mockPrismaService.task.findMany.mockResolvedValue([]);
      mockPrismaService.prReview.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([]);

      const calcSpy = jest
        .spyOn(service, 'calculateProjectScores')
        .mockResolvedValue();

      await service.applyOverride('p1', 'u1', 5, 'Bonus', 'teacher', [
        'PROJECT_MANAGER',
      ]);

      expect(
        mockProjectAccessService.assertCanManageProject,
      ).toHaveBeenCalledWith('teacher', ['PROJECT_MANAGER'], 'p1');
      expect(mockPrismaService.scoreOverride.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            delta: 5,
            reason: 'Bonus',
            overriddenBy: 'teacher',
          }) as unknown,
        }),
      );
      expect(calcSpy).toHaveBeenCalledWith('p1');
    });
  });

  describe('getUserScore', () => {
    it('allows users to view their own score after project view check', async () => {
      mockPrismaService.contributionScore.findUnique.mockResolvedValue({
        projectId: 'p1',
        userId: 'u1',
      });

      await service.getUserScore('p1', 'u1', 'u1', ['PROJECT_MEMBER']);

      expect(
        mockProjectAccessService.assertCanViewProject,
      ).toHaveBeenCalledWith('u1', ['PROJECT_MEMBER'], 'p1');
      expect(
        mockProjectAccessService.assertCanManageProject,
      ).not.toHaveBeenCalled();
    });

    it('requires scoped project management to view another user score', async () => {
      mockPrismaService.contributionScore.findUnique.mockResolvedValue({
        projectId: 'p1',
        userId: 'u2',
      });

      await service.getUserScore('p1', 'u2', 'manager', [
        'ORGANIZATION_MANAGER',
      ]);

      expect(
        mockProjectAccessService.assertCanManageProject,
      ).toHaveBeenCalledWith('manager', ['ORGANIZATION_MANAGER'], 'p1');
    });
  });
});
