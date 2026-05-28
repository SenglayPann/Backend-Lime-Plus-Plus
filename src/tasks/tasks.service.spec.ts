import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
    auditLog: {
      create: jest.fn(),
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
  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuardService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
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
      const mockTask = {
        id: 'task-1',
        externalTaskId: 'TASK-1',
        projectId: 'proj-1',
        assigneeId: 'old-user',
        pullRequests: [],
      };
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
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'TASK_REASSIGN',
          actorId: 'manager',
          projectId: 'proj-1',
          metadata: expect.objectContaining({
            type: 'MANUAL_TASK_REASSIGN',
            taskId: 'TASK-1',
            previousAssigneeId: 'old-user',
            newAssigneeId: 'new-user',
          }),
        }),
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

  describe('updateTask', () => {
    const existingTask = {
      id: 'task-1',
      projectId: 'proj-1',
      externalTaskId: 'TASK-1',
      difficulty: 'MEDIUM',
      dueDate: null,
      assigneeId: null,
      pullRequests: [],
    };

    beforeEach(() => {
      mockPrismaService.task.findUnique.mockResolvedValue(existingTask);
      mockProjectAccessService.assertCanManageProject.mockResolvedValue(undefined);
      mockProjectLockGuardService.assertProjectMutable.mockResolvedValue(undefined);
      mockPrismaService.task.update.mockResolvedValue({
        ...existingTask,
        difficulty: 'HIGH',
      });
      mockPrismaService.auditLog.create.mockResolvedValue({});
    });

    it('updates difficulty and triggers a recalc', async () => {
      const result = await service.updateTask(
        'task-1',
        { difficulty: 'HIGH' },
        'manager',
        ['PROJECT_MANAGER'],
      );

      expect(mockPrismaService.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'task-1' },
          data: { difficulty: 'HIGH' },
        }),
      );
      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'TASK_REASSIGN',
            metadata: expect.objectContaining({
              type: 'TASK_FIELDS_UPDATED',
              changes: expect.objectContaining({
                difficulty: { from: 'MEDIUM', to: 'HIGH' },
              }),
            }),
          }),
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'contribution.created',
        { projectId: 'proj-1' },
      );
      expect(result.difficulty).toBe('HIGH');
    });

    it('updates due date when provided', async () => {
      mockPrismaService.task.update.mockResolvedValueOnce({
        ...existingTask,
        dueDate: new Date('2026-06-01T00:00:00Z'),
      });
      await service.updateTask(
        'task-1',
        { dueDate: new Date('2026-06-01T00:00:00Z') },
        'manager',
        ['PROJECT_MANAGER'],
      );
      expect(mockPrismaService.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            dueDate: expect.any(Date),
          }),
        }),
      );
    });

    it('clears due date when null is passed', async () => {
      mockPrismaService.task.findUnique.mockResolvedValueOnce({
        ...existingTask,
        dueDate: new Date('2026-06-01T00:00:00Z'),
      });

      await service.updateTask(
        'task-1',
        { dueDate: null },
        'manager',
        ['PROJECT_MANAGER'],
      );

      expect(mockPrismaService.task.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { dueDate: null } }),
      );
    });

    it('is a no-op when no fields change', async () => {
      await service.updateTask(
        'task-1',
        { difficulty: 'MEDIUM' }, // same as existing
        'manager',
        ['PROJECT_MANAGER'],
      );

      expect(mockPrismaService.task.update).not.toHaveBeenCalled();
      expect(mockPrismaService.auditLog.create).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when task does not exist', async () => {
      mockPrismaService.task.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.updateTask(
          'missing',
          { difficulty: 'HIGH' },
          'manager',
          ['PROJECT_MANAGER'],
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects when project is locked', async () => {
      mockProjectLockGuardService.assertProjectMutable.mockRejectedValueOnce(
        new Error('Project is locked'),
      );

      await expect(
        service.updateTask(
          'task-1',
          { difficulty: 'HIGH' },
          'manager',
          ['PROJECT_MANAGER'],
        ),
      ).rejects.toThrow('Project is locked');
      expect(mockPrismaService.task.update).not.toHaveBeenCalled();
    });

    it('rejects when actor cannot manage the project', async () => {
      mockProjectAccessService.assertCanManageProject.mockRejectedValueOnce(
        new Error('No access'),
      );

      await expect(
        service.updateTask(
          'task-1',
          { difficulty: 'HIGH' },
          'outsider',
          ['PROJECT_MEMBER'],
        ),
      ).rejects.toThrow('No access');
      expect(mockPrismaService.task.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
