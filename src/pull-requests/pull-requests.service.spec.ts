import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectAccessService } from '../common/access/project-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { PullRequestsService } from './pull-requests.service';

describe('PullRequestsService', () => {
  let service: PullRequestsService;

  const mockPrismaService = {
    pullRequest: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockProjectAccessService = {
    assertCanViewProject: jest.fn(),
    canManageProject: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PullRequestsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
      ],
    }).compile();

    service = module.get<PullRequestsService>(PullRequestsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('returns project-wide pull requests for project managers', async () => {
      mockProjectAccessService.canManageProject.mockResolvedValue(true);
      mockPrismaService.pullRequest.findMany.mockResolvedValue([
        { id: 'pr-1' },
      ]);

      const result = await service.findAll(
        'manager',
        ['PROJECT_MANAGER'],
        'proj-1',
        'student-1',
        'MERGED',
      );

      expect(result).toEqual([{ id: 'pr-1' }]);
      expect(mockPrismaService.pullRequest.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-1',
          authorId: 'student-1',
          status: 'MERGED',
        },
        include: {
          author: true,
          task: true,
          reviews: { include: { reviewer: true } },
        },
      });
    });

    it('limits normal project members to their own pull requests', async () => {
      mockProjectAccessService.canManageProject.mockResolvedValue(false);
      mockPrismaService.pullRequest.findMany.mockResolvedValue([
        { id: 'pr-1' },
      ]);

      await service.findAll('student-1', ['PROJECT_MEMBER'], 'proj-1');

      expect(mockPrismaService.pullRequest.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-1',
          authorId: 'student-1',
          status: undefined,
        },
        include: {
          author: true,
          task: true,
          reviews: { include: { reviewer: true } },
        },
      });
    });

    it('returns no pull requests when a normal member filters by another author', async () => {
      mockProjectAccessService.canManageProject.mockResolvedValue(false);

      const result = await service.findAll(
        'student-1',
        ['PROJECT_MEMBER'],
        'proj-1',
        'student-2',
      );

      expect(result).toEqual([]);
      expect(mockPrismaService.pullRequest.findMany).not.toHaveBeenCalled();
    });
  });

  describe('validateLink', () => {
    it('allows managers to validate any scoped pull request', async () => {
      mockPrismaService.pullRequest.findUnique.mockResolvedValue({
        id: 'pr-1',
        projectId: 'proj-1',
        taskId: 'task-1',
        authorId: 'student-1',
        status: 'MERGED',
        author: { githubUserId: '101' },
        task: { externalTaskId: 'T-1', assigneeId: 'student-1' },
      });
      mockProjectAccessService.canManageProject.mockResolvedValue(true);

      await expect(
        service.validateLink('pr-1', 'manager', ['PROJECT_MANAGER']),
      ).resolves.toEqual({
        valid: true,
        task_id: 'T-1',
        merged: true,
        author_login: '101',
        assignee_match: true,
      });
    });

    it('allows normal members to validate their own pull request', async () => {
      mockPrismaService.pullRequest.findUnique.mockResolvedValue({
        id: 'pr-1',
        projectId: 'proj-1',
        authorId: 'student-1',
        status: 'OPEN',
        author: { githubUserId: '101' },
        task: null,
      });
      mockProjectAccessService.canManageProject.mockResolvedValue(false);

      await expect(
        service.validateLink('pr-1', 'student-1', ['PROJECT_MEMBER']),
      ).resolves.toMatchObject({
        valid: false,
        task_id: null,
        merged: false,
        author_login: '101',
        assignee_match: null,
      });
    });

    it('blocks normal members from validating another author pull request', async () => {
      mockPrismaService.pullRequest.findUnique.mockResolvedValue({
        id: 'pr-1',
        projectId: 'proj-1',
        authorId: 'student-2',
        status: 'OPEN',
        author: { githubUserId: '102' },
        task: null,
      });
      mockProjectAccessService.canManageProject.mockResolvedValue(false);

      await expect(
        service.validateLink('pr-1', 'student-1', ['PROJECT_MEMBER']),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when the pull request is missing', async () => {
      mockPrismaService.pullRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.validateLink('missing', 'student-1', ['PROJECT_MEMBER']),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
