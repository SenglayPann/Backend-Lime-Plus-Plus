import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../common/access/project-access.service';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import { DepartmentAccessService } from '../common/access/department-access.service';

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
      findMany: jest.fn(),
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
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    organization: {
      findUnique: jest.fn(),
    },
  };

  const mockProjectAccessService = {
    getManageableProjectIds: jest.fn(),
  };
  const mockOrganizationAccessService = {
    assertCanManageOrganization: jest.fn(),
  };
  const mockDepartmentAccessService = {
    assertCanManageDepartment: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
        {
          provide: OrganizationAccessService,
          useValue: mockOrganizationAccessService,
        },
        { provide: DepartmentAccessService, useValue: mockDepartmentAccessService },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
    jest.clearAllMocks();
  });

  describe('getGlobalStats', () => {
    it('should return global stats', async () => {
      mockProjectAccessService.getManageableProjectIds.mockResolvedValue([
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
      mockProjectAccessService.getManageableProjectIds.mockResolvedValue([]);

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
      mockProjectAccessService.getManageableProjectIds.mockResolvedValue([
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
      mockProjectAccessService.getManageableProjectIds.mockResolvedValue([
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

  describe('getOrganizationDashboard', () => {
    it('returns scoped organization dashboard aggregates', async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue({
        id: 'org-1',
        name: 'Demo University',
        licensePlan: 'academic',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        userRoles: [{ user: { name: 'Dean', githubUsername: null } }],
        _count: { departments: 1, userRoles: 1 },
      });
      mockPrismaService.department.findMany.mockResolvedValue([
        {
          id: 'dept-1',
          name: 'Computer Science',
          userRoles: [{ user: { name: 'Principal', githubUsername: null } }],
        },
      ]);
      mockPrismaService.project.findMany.mockResolvedValue([
        {
          id: 'project-1',
          name: 'Capstone',
          status: 'ACTIVE',
          repository: 'org/repo',
          departmentId: 'dept-1',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          department: {
            id: 'dept-1',
            name: 'Computer Science',
            organizationId: 'org-1',
            organization: { name: 'Demo University' },
          },
          members: [
            {
              userId: 'u1',
              user: { name: 'Student', githubUsername: 'student' },
            },
          ],
          tasks: [
            {
              assigneeId: 'u1',
              status: 'DONE',
              assignee: { name: 'Student', githubUsername: 'student' },
            },
          ],
          pullRequests: [
            {
              authorId: 'u1',
              status: 'MERGED',
              author: { name: 'Student', githubUsername: 'student' },
              reviews: [],
            },
          ],
          contributionScores: [
            {
              userId: 'u1',
              totalScore: 42,
              user: { name: 'Student', githubUsername: 'student' },
            },
          ],
          scoreOverrides: [],
        },
      ]);

      const result = await service.getOrganizationDashboard('org-1', 'admin', [
        'ADMIN',
      ]);

      expect(result.summary).toEqual(
        expect.objectContaining({
          departments: 1,
          projects: 1,
          members: 1,
          doneTasks: 1,
          mergedPrs: 1,
          avgScore: 42,
        }),
      );
      expect(result.departments[0]).toEqual(
        expect.objectContaining({ id: 'dept-1', avgScore: 42 }),
      );
      expect(result.scope.managers).toEqual(['Dean']);
      expect(result.contributors[0]).toEqual(
        expect.objectContaining({ userId: 'u1', totalScore: 42 }),
      );
    });
  });
});
