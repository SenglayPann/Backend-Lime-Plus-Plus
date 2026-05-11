import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DashboardService', () => {
  let service: DashboardService;

  const mockPrismaService = {
    userRole: {
      count: jest.fn(),
    },
    project: {
      count: jest.fn(),
    },
    pullRequest: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    contributionScore: {
      findMany: jest.fn(),
    },
    department: {
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    jest.clearAllMocks();
  });

  describe('getGlobalStats', () => {
    it('should return global stats', async () => {
      mockPrismaService.userRole.count.mockResolvedValue(100);
      mockPrismaService.project.count.mockResolvedValue(10);
      mockPrismaService.pullRequest.count.mockResolvedValue(50);
      mockPrismaService.contributionScore.findMany.mockResolvedValue([
        { totalScore: 80 },
        { totalScore: 90 },
      ]);

      const result = await service.getGlobalStats();

      expect(result).toEqual({
        activeStudents: 100,
        ongoingProjects: 10,
        pullRequests: 50,
        avgContribution: 85,
      });
    });

    it('should handle zero scores for avgContribution', async () => {
      mockPrismaService.userRole.count.mockResolvedValue(0);
      mockPrismaService.project.count.mockResolvedValue(0);
      mockPrismaService.pullRequest.count.mockResolvedValue(0);
      mockPrismaService.contributionScore.findMany.mockResolvedValue([]);

      const result = await service.getGlobalStats();

      expect(result).toEqual({
        activeStudents: 0,
        ongoingProjects: 0,
        pullRequests: 0,
        avgContribution: 0,
      });
    });
  });

  describe('getRecentActivity', () => {
    it('should return recent PRs mapped', async () => {
      mockPrismaService.pullRequest.findMany.mockResolvedValue([
        {
          id: 'pr-1',
          title: 'Test PR',
          mergedAt: new Date('2026-01-01T00:00:00.000Z'),
          author: { name: 'Senglay', githubUsername: 'senglay' },
          project: { name: 'Test Project' },
        },
      ]);

      const result = await service.getRecentActivity();

      expect(result).toEqual([
        {
          id: 'pr-1',
          title: 'Test PR',
          projectName: 'Test Project',
          authorName: 'Senglay',
          mergedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
    });
  });

  describe('getTopDepartments', () => {
    it('should calculate and return top departments', async () => {
      mockPrismaService.department.findMany.mockResolvedValue([
        {
          id: 'dept-1',
          name: 'Computer Science',
          projects: [
            { contributionScores: [{ totalScore: 90 }, { totalScore: 100 }] },
          ],
        },
        {
          id: 'dept-2',
          name: 'IT',
          projects: [
            { contributionScores: [{ totalScore: 80 }] },
          ],
        },
      ]);

      const result = await service.getTopDepartments();

      expect(result).toEqual([
        { id: 'dept-1', name: 'Computer Science', avgScore: 95 },
        { id: 'dept-2', name: 'IT', avgScore: 80 },
      ]);
    });
  });
});
