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
import { PrLifecycleHandler } from './pr-lifecycle.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubService } from '../github.service';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { GitHubPullRequestEventPayload } from '../github-payloads';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';

describe('PrLifecycleHandler', () => {
  let handler: PrLifecycleHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
    task: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    pullRequest: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    contributionEvent: { create: jest.fn(), upsert: jest.fn() },
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  const mockGitHubService = {
    getAppInstallationToken: jest.fn(),
    createCommitStatus: jest.fn(),
  };
  const mockProjectLockGuard = {
    isLocked: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrLifecycleHandler,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: GitHubService, useValue: mockGitHubService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuard },
      ],
    }).compile();

    handler = module.get<PrLifecycleHandler>(PrLifecycleHandler);
    jest.clearAllMocks();

    // Silence logger during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    mockProjectLockGuard.isLocked.mockImplementation(
      (project: { status: string }) => project.status === 'LOCKED',
    );
  });

  it('should parse task ID correctly', () => {
    expect(handler.parseTaskId('Update [TASK-123] readme', null)).toBe(
      'TASK-123',
    );
    expect(handler.parseTaskId('No task here', 'But body has TASK-456')).toBe(
      'TASK-456',
    );
    expect(handler.parseTaskId('Update [TASK-ABC_123]', null)).toBe(
      'TASK-ABC_123',
    );
    expect(handler.parseTaskId('Missing', 'Also missing')).toBeNull();
  });

  describe('parseTaskId GitHub closure-keyword fallback', () => {
    it('matches "Closes #N" in the body', () => {
      expect(handler.parseTaskId('Add login screen', 'Closes #42')).toBe(
        'TASK-42',
      );
    });

    it('matches "Fixes #N" in the body case-insensitively', () => {
      expect(handler.parseTaskId('Some title', 'fixes #7')).toBe('TASK-7');
      expect(handler.parseTaskId('Some title', 'FIX #7')).toBe('TASK-7');
    });

    it('matches "Resolves #N" / "Resolved #N"', () => {
      expect(handler.parseTaskId('x', 'Resolves #100')).toBe('TASK-100');
      expect(handler.parseTaskId('x', 'Resolved #100')).toBe('TASK-100');
    });

    it('matches in the title', () => {
      expect(handler.parseTaskId('Closes #5: add login', null)).toBe('TASK-5');
    });

    it('prefers TASK-N over Closes #N when both appear', () => {
      // TASK-N has priority — preserves existing behaviour.
      expect(
        handler.parseTaskId('TASK-77 add login', 'Closes #42'),
      ).toBe('TASK-77');
    });

    it('does not match without a closure keyword', () => {
      expect(handler.parseTaskId('Mention of #42 in title', null)).toBeNull();
      expect(handler.parseTaskId('x', 'See issue #42 for context')).toBeNull();
    });

    it('does not match partial words like "closing on #42"', () => {
      expect(
        handler.parseTaskId('x', 'Closing on #42 to keep things tidy'),
      ).toBeNull();
    });

    it('takes the first match when multiple keywords are present', () => {
      expect(handler.parseTaskId('x', 'Closes #1 and fixes #2')).toBe(
        'TASK-1',
      );
    });
  });

  it('should ignore invalid payloads', async () => {
    await handler.handle({});
    expect(mockPrismaService.project.findFirst).not.toHaveBeenCalled();
  });

  describe('handleOpenedOrSync', () => {
    const defaultPayload: GitHubPullRequestEventPayload = {
      action: 'opened',
      pull_request: {
        id: 1,
        node_id: 'node-1',
        number: 1,
        title: '[TASK-42] Hello',
        body: null,
        user: { id: 101, login: 'octocat', avatar_url: 'url' },
        html_url: 'pr-url',
        head: { sha: 'abc', ref: 'head', label: 'head', repo: { id: 1 } },
        base: { sha: 'def', ref: 'base', label: 'base', repo: { id: 1 } },
        state: 'open',
        merged: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      repository: {
        id: 1,
        node_id: 'node-repo',
        full_name: 'test/repo',
        owner: { id: 1, login: 'test' },
        name: 'repo',
        private: false,
        html_url: 'repo-url',
      },
      installation: { id: 123 },
    } as unknown as GitHubPullRequestEventPayload;

    const project = { id: 'p1', status: 'ACTIVE' };

    it('should reject PR if project is locked', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue({
        id: 'p1',
        status: 'LOCKED',
      });
      await handler.handle(defaultPayload);
      expect(mockPrismaService.pullRequest.upsert).not.toHaveBeenCalled();
    });

    it('should persist PR indicating INVALID if no task found', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue(project);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });

      const payloadNoTask = JSON.parse(
        JSON.stringify(defaultPayload),
      ) as GitHubPullRequestEventPayload;
      payloadNoTask.pull_request.title = 'No task here';

      await handler.handle(payloadNoTask);

      expect(mockPrismaService.pullRequest.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ taskId: null }) as unknown,
        }),
      );
    });

    it('should FLAG if PR author is not assignee', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue(project);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        assignee: { githubUserId: '999', name: 'Other' },
      });

      await handler.handle(defaultPayload);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'TASK_REASSIGN' }) as unknown,
        }),
      );
    });

    it('should FLAG if linked task is unassigned', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue(project);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });
      mockPrismaService.task.findUnique.mockResolvedValue({
        id: 't1',
        assignee: null,
      });

      await handler.handle(defaultPayload);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              type: 'PR_ASSIGNEE_MISMATCH',
              taskAssignee: 'Unassigned',
            }) as unknown,
          }) as unknown,
        }),
      );
      expect(mockPrismaService.pullRequest.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ taskId: 't1' }) as unknown,
        }),
      );
    });
  });

  describe('handleClosed', () => {
    const mergedPayload: GitHubPullRequestEventPayload = {
      action: 'closed',
      pull_request: {
        id: 1,
        node_id: 'node-1',
        number: 1,
        title: '[TASK-42] Hello',
        body: null,
        user: { id: 101, login: 'octocat', avatar_url: 'url' },
        html_url: 'pr-url',
        head: { sha: 'abc', ref: 'head', label: 'head', repo: { id: 1 } },
        base: { sha: 'def', ref: 'base', label: 'base', repo: { id: 1 } },
        state: 'closed',
        merged: true,
        merged_at: '2026-05-01T00:00:00Z',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      repository: {
        id: 1,
        node_id: 'node-repo',
        full_name: 'test/repo',
        owner: { id: 1, login: 'test' },
        name: 'repo',
        private: false,
        html_url: 'repo-url',
      },
    } as unknown as GitHubPullRequestEventPayload;

    it('should emit one TASK_COMPLETED event for a valid merged PR', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
      });
      mockPrismaService.pullRequest.findUnique.mockResolvedValue({
        id: 'pr1',
        taskId: 't1',
        authorId: 'u1',
        task: {
          id: 't1',
          externalTaskId: 'TASK-42',
          assigneeId: 'u1',
          status: 'IN_PROGRESS',
          completedAt: null,
        },
      });
      mockPrismaService.pullRequest.findFirst.mockResolvedValue(null);

      await handler.handle(mergedPayload);

      expect(mockPrismaService.contributionEvent.upsert).toHaveBeenCalledTimes(
        1,
      );
      expect(mockPrismaService.contributionEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            type: 'TASK_COMPLETED',
            referenceId: 't1',
            score: 10,
          }) as unknown,
        }),
      );
    });

    it('should not score a merged PR authored by the wrong assignee', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
      });
      mockPrismaService.pullRequest.findUnique.mockResolvedValue({
        id: 'pr1',
        taskId: 't1',
        authorId: 'u1',
        task: {
          id: 't1',
          externalTaskId: 'TASK-42',
          assigneeId: 'u2',
          status: 'IN_PROGRESS',
          completedAt: null,
        },
      });

      await handler.handle(mergedPayload);

      expect(mockPrismaService.contributionEvent.upsert).not.toHaveBeenCalled();
    });
  });
});
