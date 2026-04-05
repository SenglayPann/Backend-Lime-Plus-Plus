jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { TaskSyncHandler } from './task-sync.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';

describe('TaskSyncHandler', () => {
  let handler: TaskSyncHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
    task: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskSyncHandler,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    handler = module.get<TaskSyncHandler>(TaskSyncHandler);
    jest.clearAllMocks();
    
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  const basePayload = {
    projects_v2_item: { project_node_id: 'pn1', node_id: 'n1', content_node_id: 'cn1' },
    sender: { id: 1, login: 'user1' },
  };

  it('should handle created action by creating a new task', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue(null);
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });

    await handler.handle({ ...basePayload, action: 'created' });

    expect(mockPrismaService.task.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ externalTaskId: 'TASK-cn1', assigneeId: 'u1', status: 'TODO' })
    }));
  });

  it('should handle edited action by updating status', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue({
      id: 't1', status: 'TODO', assigneeId: 'u1', pullRequests: []
    });

    const payload = {
      ...basePayload,
      action: 'edited',
      projects_v2_item: {
        ...basePayload.projects_v2_item,
        changes: { field_value: { field_name: 'Status', to: { name: 'Done' } } }
      }
    };

    await handler.handle(payload);

    expect(mockPrismaService.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'DONE' }
    });
  });

  it('should flag and audit task reassignment', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue({
      id: 't1', status: 'TODO', assigneeId: 'u1', pullRequests: [{ status: 'OPEN' }], assignee: { name: 'Old Assignee' }
    });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u2' }); // New assignee

    const payload = {
      ...basePayload,
      action: 'edited',
      projects_v2_item: {
        ...basePayload.projects_v2_item,
        changes: { field_value: { field_name: 'Assignees' } }
      }
    };

    await handler.handle(payload);

    expect(mockPrismaService.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { assigneeId: 'u2' }
    });

    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'TASK_REASSIGN',
        metadata: expect.objectContaining({ hasOpenPRs: true })
      })
    }));
  });

  it('should soft-delete task on delete action', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue({ id: 't1' });

    await handler.handle({ ...basePayload, action: 'deleted' });

    expect(mockPrismaService.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'BLOCKED' } // Soft delete
    });
  });
});
