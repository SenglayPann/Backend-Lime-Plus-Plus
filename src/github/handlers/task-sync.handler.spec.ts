jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest
    .fn()
    .mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskSyncHandler } from './task-sync.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';

import { GitHubProjectV2ItemEventPayload } from '../github-payloads';

describe('TaskSyncHandler', () => {
  let handler: TaskSyncHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
    task: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    projectMember: { upsert: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const mockProjectLockGuard = {
    isLocked: jest.fn(),
  };
  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskSyncHandler,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuard },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    handler = module.get<TaskSyncHandler>(TaskSyncHandler);
    jest.clearAllMocks();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    mockProjectLockGuard.isLocked.mockReturnValue(false);
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'sender-user' });
  });

  const basePayload = {
    action: 'created',
    projects_v2_item: {
      project_node_id: 'pn1',
      node_id: 'n1',
      content_node_id: 'cn1',
      content_type: 'Issue',
      creator: { id: 1, login: 'creator' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    sender: { id: 1, login: 'user1' },
    organization: { id: 1, login: 'org' },
  } as unknown as GitHubProjectV2ItemEventPayload;

  it('should handle created action by creating a new task', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue(null);
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });

    await handler.handle({
      ...basePayload,
      action: 'created',
      projects_v2_item: {
        ...basePayload.projects_v2_item,
        content: {
          title: 'Assigned task',
          assignees: {
            nodes: [{ id: 101, login: 'student', avatar_url: 'avatar' }],
          },
        },
      },
    } as GitHubProjectV2ItemEventPayload);

    expect(mockPrismaService.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalTaskId: 'TASK-cn1',
          assigneeId: 'u1',
          status: 'TODO',
        }) as unknown,
      }),
    );
  });

  it('should import created project items without an assignee', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue(null);

    await handler.handle({
      ...basePayload,
      action: 'created',
      projects_v2_item: {
        ...basePayload.projects_v2_item,
        content: { title: 'Unassigned task' },
      },
    } as GitHubProjectV2ItemEventPayload);

    expect(mockPrismaService.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalTaskId: 'TASK-cn1',
          assigneeId: null,
          title: 'Unassigned task',
        }) as unknown,
      }),
    );
    expect(mockPrismaService.projectMember.upsert).not.toHaveBeenCalled();
  });

  it('should handle edited action by updating status', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue({
      id: 't1',
      status: 'TODO',
      assigneeId: 'u1',
      pullRequests: [],
    });

    const payload = {
      ...basePayload,
      action: 'edited',
      projects_v2_item: {
        ...basePayload.projects_v2_item,
        changes: {
          field_value: { field_name: 'Status', to: { name: 'Done' } },
        },
      },
    } as GitHubProjectV2ItemEventPayload;

    await handler.handle(payload);

    expect(mockPrismaService.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'DONE' },
    });
    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TASK_REASSIGN',
          actorId: 'sender-user',
          metadata: expect.objectContaining({
            type: 'TASK_STATUS_CHANGE',
            taskId: 'TASK-cn1',
            previousStatus: 'TODO',
            newStatus: 'DONE',
          }) as unknown,
        }) as unknown,
      }),
    );
  });

  it('should flag and audit task reassignment', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue({
      id: 't1',
      status: 'TODO',
      assigneeId: 'u1',
      pullRequests: [{ status: 'OPEN' }],
      assignee: { name: 'Old Assignee' },
    });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u2' }); // New assignee

    const payload = {
      ...basePayload,
      action: 'edited',
      projects_v2_item: {
        ...basePayload.projects_v2_item,
        content: {
          title: 'Assigned task',
          assignees: {
            nodes: [{ id: 202, login: 'new-assignee', avatar_url: 'avatar' }],
          },
        },
        changes: { field_value: { field_name: 'Assignees' } },
      },
    } as GitHubProjectV2ItemEventPayload;

    await handler.handle(payload);

    expect(mockPrismaService.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { assigneeId: 'u2' },
    });

    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TASK_REASSIGN',
          metadata: expect.objectContaining({ hasOpenPRs: true }) as unknown,
        }) as unknown,
      }),
    );
  });

  it('should allow assignee edits to clear an assignment', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue({
      id: 't1',
      status: 'TODO',
      assigneeId: 'u1',
      pullRequests: [],
      assignee: { name: 'Old Assignee' },
    });

    const payload = {
      ...basePayload,
      action: 'edited',
      projects_v2_item: {
        ...basePayload.projects_v2_item,
        content: { title: 'Unassigned task' },
        changes: { field_value: { field_name: 'Assignees' } },
      },
    } as GitHubProjectV2ItemEventPayload;

    await handler.handle(payload);

    expect(mockPrismaService.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { assigneeId: null },
    });
    expect(mockPrismaService.projectMember.upsert).not.toHaveBeenCalled();
    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            type: 'TASK_ASSIGNEE_CHANGE',
            previousAssigneeId: 'u1',
            newAssigneeId: null,
          }) as unknown,
        }) as unknown,
      }),
    );
  });

  it('should soft-delete task on delete action', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.task.findUnique.mockResolvedValue({ id: 't1' });

    await handler.handle({ ...basePayload, action: 'deleted' });

    expect(mockPrismaService.task.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'BLOCKED' }, // Soft delete
    });
    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TASK_REASSIGN',
          actorId: 'sender-user',
          metadata: expect.objectContaining({
            type: 'TASK_SOFT_DELETE',
            taskId: 'TASK-cn1',
            previousStatus: undefined,
            newStatus: 'BLOCKED',
          }) as unknown,
        }) as unknown,
      }),
    );
  });
});
