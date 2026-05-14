import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProjectAccessService } from '../common/access/project-access.service';
import { ProjectLockGuardService } from '../common/access/project-lock-guard.service';
import {
  expectNoSensitiveFields,
  safeUserSelect,
} from '../common/serialization/safe-user-select';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';

describe('TasksService', () => {
  let service: TasksService;

  const mockPrismaService = {
    task: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    projectMember: {
      findFirst: jest.fn(),
    },
  };

  const mockProjectAccessService = {
    assertCanViewProject: jest.fn(),
    canManageProject: jest.fn(),
    getAccessibleProjectIds: jest.fn(),
    getManageableProjectIds: jest.fn(),
    assertCanManageProject: jest.fn(),
  };
  const mockProjectLockGuardService = {
    assertProjectMutable: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuardService },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('returns project-wide tasks for project managers', async () => {
      const mockTasks = [{ id: 'task-1' }];
      mockProjectAccessService.canManageProject.mockResolvedValue(true);
      mockPrismaService.task.findMany.mockResolvedValue(mockTasks);

      const result = await service.findAll(
        'manager',
        ['PROJECT_MANAGER'],
        'proj-1',
        'student-1',
        'TODO',
      );

      expect(result).toEqual(mockTasks);
      expect(
        mockProjectAccessService.assertCanViewProject,
      ).toHaveBeenCalledWith('manager', ['PROJECT_MANAGER'], 'proj-1');
      expect(mockPrismaService.task.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-1',
          assigneeId: 'student-1',
          status: 'TODO',
        },
        include: {
          project: true,
          assignee: { select: safeUserSelect },
          pullRequests: true,
        },
      });
    });

    it('limits normal project members to their own project tasks', async () => {
      mockProjectAccessService.canManageProject.mockResolvedValue(false);
      mockPrismaService.task.findMany.mockResolvedValue([{ id: 'task-1' }]);

      await service.findAll('student-1', ['PROJECT_MEMBER'], 'proj-1');

      expect(mockPrismaService.task.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-1',
          assigneeId: 'student-1',
          status: undefined,
        },
        include: {
          project: true,
          assignee: { select: safeUserSelect },
          pullRequests: true,
        },
      });
    });

    it('returns no tasks when a normal member filters by another assignee', async () => {
      mockProjectAccessService.canManageProject.mockResolvedValue(false);

      const result = await service.findAll(
        'student-1',
        ['PROJECT_MEMBER'],
        'proj-1',
        'student-2',
      );

      expect(result).toEqual([]);
      expect(mockPrismaService.task.findMany).not.toHaveBeenCalled();
    });

    it('mixes project-wide manager scopes with own-only member scopes', async () => {
      mockProjectAccessService.getAccessibleProjectIds.mockResolvedValue([
        'managed-project',
        'member-project',
      ]);
      mockProjectAccessService.getManageableProjectIds.mockResolvedValue([
        'managed-project',
      ]);
      mockPrismaService.task.findMany.mockResolvedValue([]);

      await service.findAll('actor-1', ['PROJECT_MANAGER', 'PROJECT_MEMBER']);

      expect(mockPrismaService.task.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            {
              projectId: { in: ['managed-project'] },
              assigneeId: undefined,
            },
            {
              projectId: { in: ['member-project'] },
              assigneeId: 'actor-1',
            },
          ],
          status: undefined,
        },
        include: {
          project: true,
          assignee: { select: safeUserSelect },
          pullRequests: true,
        },
      });
    });

    it('returns no tasks when the actor has no accessible projects', async () => {
      mockProjectAccessService.getAccessibleProjectIds.mockResolvedValue([]);
      mockProjectAccessService.getManageableProjectIds.mockResolvedValue([]);

      const result = await service.findAll('actor-1', ['PROJECT_MEMBER']);

      expect(result).toEqual([]);
      expect(mockPrismaService.task.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns a task by id', async () => {
      const mockTask = {
        id: 'task-1',
        assignee: {
          id: 'user-1',
          githubUserId: '101',
          githubUsername: 'octocat',
          email: 'octocat@example.com',
          name: 'Octo Cat',
          avatarUrl: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      };
      mockPrismaService.task.findUnique.mockResolvedValue(mockTask);

      const result = await service.findOne('task-1');

      expect(result).toEqual(mockTask);
      expectNoSensitiveFields(result);
      expect(mockPrismaService.task.findUnique).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        include: {
          project: true,
          assignee: { select: safeUserSelect },
          pullRequests: true,
        },
      });
    });

    it('throws NotFoundException if task is not found', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue(null);

      await expect(service.findOne('task-unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('assignTask', () => {
    it('assigns a task to an existing project member', async () => {
      const mockTask = { id: 'task-1', projectId: 'proj-1' };
      const updatedTask = { ...mockTask, assigneeId: 'new-user' };

      jest.spyOn(service, 'findOne').mockResolvedValue(mockTask as any);
      mockPrismaService.projectMember.findFirst.mockResolvedValue({
        id: 'member-1',
      });
      mockPrismaService.task.update.mockResolvedValue(updatedTask);

      const result = await service.assignTask('task-1', 'new-user', 'manager', [
        'PROJECT_MANAGER',
      ]);

      expect(
        mockProjectLockGuardService.assertProjectMutable,
      ).toHaveBeenCalledWith('proj-1', 'assign tasks');
      expect(
        mockProjectAccessService.assertCanManageProject,
      ).toHaveBeenCalledWith('manager', ['PROJECT_MANAGER'], 'proj-1');
      expect(mockPrismaService.projectMember.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-1',
          userId: 'new-user',
        },
        select: { id: true },
      });
      expect(mockPrismaService.task.update).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { assigneeId: 'new-user' },
      });
      expect(result).toEqual(updatedTask);
    });

    it('rejects task assignment to a non-member', async () => {
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue({ id: 'task-1', projectId: 'proj-1' } as any);
      mockPrismaService.projectMember.findFirst.mockResolvedValue(null);

      await expect(
        service.assignTask('task-1', 'outsider', 'manager', [
          'PROJECT_MANAGER',
        ]),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
