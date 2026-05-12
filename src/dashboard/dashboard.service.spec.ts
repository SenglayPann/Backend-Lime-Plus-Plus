import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../common/access/project-access.service';

describe('DashboardService', () => {
  let service: DashboardService;

  const mockPrismaService = {
    userRole: {
      count: jest.fn(),
    },
    projectMember: {
      groupBy: jest.fn(),
    },
    project: {
      count: jest.fn(),
    },
    pullRequest: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    contributionEvent: {
      findMany: jest.fn(),
    },
    contributionScore: {
      findMany: jest.fn(),
    },
    department: {
      findMany: jest.fn(),
    },
  };

  const mockProjectAccessService = {
    getAccessibleProjectIds: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    jest.clearAllMocks();
  });

  describe('getGlobalStats', () => {
    it('should return global stats', async () => {
      mockProjectAccessService.getAccessibleProjectIds.mockResolvedValue([
        'p1',
        'p2',
      ]);
      mockPrismaService.projectMember.groupBy.mockResolvedValue(
        Array.from({ length: 100 }, (_, index) => ({ userId: `u${index}` })),
      );
      mockPrismaService.project.count.mockResolvedValue(10);
      mockPrismaService.pullRequest.count.mockResolvedValue(50);
      mockPrismaService.contributionScore.findMany.mockResolvedValue([
        { totalScore: 80 },
        { totalScore: 90 },
      ]);

      const result = await service.getGlobalStats('admin', ['ADMIN']);

      expect(result).toEqual({
        activeStudents: 100,
        ongoingProjects: 10,
        pullRequests: 50,
        avgContribution: 85,
      });
    });

    it('should handle zero scores for avgContribution', async () => {
      mockProjectAccessService.getAccessibleProjectIds.mockResolvedValue([]);

      const result = await service.getGlobalStats('admin', ['ADMIN']);

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
      mockProjectAccessService.getAccessibleProjectIds.mockResolvedValue([
        'p1',
      ]);
      mockPrismaService.contributionEvent.findMany.mockResolvedValue([
        {
          id: 'event-1',
          type: 'TASK_COMPLETED',
          score: 10,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          user: { name: 'Senglay', githubUsername: 'senglay' },
          project: { id: 'p1', name: 'Test Project' },
        },
      ]);

      const result = await service.getRecentActivity('admin', ['ADMIN']);

      expect(result).toEqual([
        {
          id: 'event-1',
          title: 'Task Completed',
          projectId: 'p1',
          projectName: 'Test Project',
          authorName: 'Senglay',
          score: 10,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
    });
  });

  describe('getTopDepartments', () => {
    it('should calculate and return top departments', async () => {
      mockProjectAccessService.getAccessibleProjectIds.mockResolvedValue([
        'p1',
      ]);
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
          projects: [{ contributionScores: [{ totalScore: 80 }] }],
        },
      ]);

      const result = await service.getTopDepartments('admin', ['ADMIN']);

      expect(result).toEqual([
        { id: 'dept-1', name: 'Computer Science', avgScore: 95 },
        { id: 'dept-2', name: 'IT', avgScore: 80 },
      ]);
    });
  });
});
