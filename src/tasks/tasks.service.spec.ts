import { Test, TestingModule } from '@nestjs/testing';
import { TasksService } from './tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { TaskStatus } from '../generated/prisma';

describe('TasksService', () => {
  let service: TasksService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    task: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should return all tasks matching criteria', async () => {
      const mockTasks = [{ id: 'task-1' }];
      mockPrismaService.task.findMany.mockResolvedValue(mockTasks);

      const result = await service.findAll('proj-1', 'user-1', 'TODO');

      expect(result).toEqual(mockTasks);
      expect(mockPrismaService.task.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-1',
          assigneeId: 'user-1',
          status: 'TODO' as TaskStatus,
        },
        include: {
          project: true,
          assignee: true,
          pullRequests: true,
        },
      });
    });

    it('should ignore undefined criteria', async () => {
      mockPrismaService.task.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(mockPrismaService.task.findMany).toHaveBeenCalledWith({
        where: {
          projectId: undefined,
          assigneeId: undefined,
          status: undefined,
        },
        include: {
          project: true,
          assignee: true,
          pullRequests: true,
        },
      });
    });
  });

  describe('findOne', () => {
    it('should return a task by id', async () => {
      const mockTask = { id: 'task-1' };
      mockPrismaService.task.findUnique.mockResolvedValue(mockTask);

      const result = await service.findOne('task-1');

      expect(result).toEqual(mockTask);
      expect(mockPrismaService.task.findUnique).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        include: { project: true, assignee: true, pullRequests: true },
      });
    });

    it('should throw NotFoundException if task not found', async () => {
      mockPrismaService.task.findUnique.mockResolvedValue(null);

      await expect(service.findOne('task-unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('assignTask', () => {
    it('should assign a task to a user', async () => {
      const mockTask = { id: 'task-1', assigneeId: 'old-user' };
      const updatedTask = { ...mockTask, assigneeId: 'new-user' };

      // mock findOne internal call
      jest.spyOn(service, 'findOne').mockResolvedValue(mockTask as any);
      mockPrismaService.task.update.mockResolvedValue(updatedTask);

      const result = await service.assignTask('task-1', 'new-user');

      expect(service.findOne).toHaveBeenCalledWith('task-1');
      expect(mockPrismaService.task.update).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        data: { assigneeId: 'new-user' },
      });
      expect(result).toEqual(updatedTask);
    });
  });
});
