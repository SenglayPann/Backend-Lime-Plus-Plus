import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { IssuesHandler } from './issues.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';
import { GitHubIssuesEventPayload } from '../github-payloads';

describe('IssuesHandler', () => {
  let handler: IssuesHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
    task: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const mockProjectLockGuard = { isLocked: jest.fn().mockReturnValue(false) };
  const mockEventEmitter = { emit: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuesHandler,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuard },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();
    handler = module.get(IssuesHandler);
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    mockProjectLockGuard.isLocked.mockReturnValue(false);
  });

  function payload(
    action: string,
    extra: Partial<GitHubIssuesEventPayload> = {},
  ): GitHubIssuesEventPayload {
    return {
      action,
      repository: {
        id: 1,
        name: 'repo',
        full_name: 'org/repo',
        owner: { id: 1, login: 'org' },
      } as any,
      sender: { id: 99, login: 'octo' } as any,
      issue: {
        id: 42,
        node_id: 'I_42',
        number: 7,
        title: 'New title',
        body: null,
        state: 'open',
        html_url: 'https://github.com/org/repo/issues/7',
        user: { id: 1, login: 'octo' } as any,
        assignees: [],
        labels: [],
        closed_at: null,
        created_at: '',
        updated_at: '',
      },
      ...extra,
    } as GitHubIssuesEventPayload;
  }

  it('emits project.updated when an issue title changes', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
    });
    mockPrismaService.task.findUnique.mockResolvedValue({
      id: 't1',
      title: 'Old title',
      status: 'TODO',
      assigneeId: null,
    });
    mockPrismaService.task.update.mockResolvedValue({});

    await handler.handle(payload('edited'));

    expect(mockPrismaService.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { title: 'New title' },
      }),
    );
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      'project.updated',
      expect.objectContaining({ projectId: 'p1', kind: 'issue' }),
    );
  });

  it('marks the task DONE on issue closed', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
    });
    mockPrismaService.task.findUnique.mockResolvedValue({
      id: 't1',
      title: 'X',
      status: 'IN_PROGRESS',
      assigneeId: null,
    });

    await handler.handle(payload('closed'));

    expect(mockPrismaService.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'DONE' } }),
    );
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      'project.updated',
      expect.objectContaining({ kind: 'issue' }),
    );
  });

  it('returns silently when there is no matching task', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
    });
    mockPrismaService.task.findUnique.mockResolvedValue(null);

    await handler.handle(payload('edited'));

    expect(mockPrismaService.task.update).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('does nothing when project is locked', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'LOCKED',
    });
    mockProjectLockGuard.isLocked.mockReturnValue(true);
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u-1' });

    await handler.handle(payload('closed'));

    expect(mockPrismaService.task.update).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });
});
