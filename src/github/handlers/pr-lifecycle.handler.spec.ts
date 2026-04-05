jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PrLifecycleHandler } from './pr-lifecycle.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubService } from '../github.service';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('PrLifecycleHandler', () => {
  let handler: PrLifecycleHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
    task: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    pullRequest: { upsert: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
    contributionEvent: { create: jest.fn() },
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  const mockGitHubService = {
    getAppInstallationToken: jest.fn(),
    createCommitStatus: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrLifecycleHandler,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: GitHubService, useValue: mockGitHubService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    handler = module.get<PrLifecycleHandler>(PrLifecycleHandler);
    jest.clearAllMocks();
    
    // Silence logger during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('should parse task ID correctly', () => {
    expect(handler.parseTaskId('Update [TASK-123] readme', null)).toBe('TASK-123');
    expect(handler.parseTaskId('No task here', 'But body has TASK-456')).toBe('TASK-456');
    expect(handler.parseTaskId('Missing', 'Also missing')).toBeNull();
  });

  it('should ignore invalid payloads', async () => {
    await handler.handle({});
    expect(mockPrismaService.project.findFirst).not.toHaveBeenCalled();
  });

  describe('handleOpenedOrSync', () => {
    const defaultPayload = {
      action: 'opened',
      pull_request: {
        number: 1,
        title: '[TASK-42] Hello',
        body: null,
        user: { id: 101, login: 'octocat', avatar_url: 'url' },
        html_url: 'pr-url',
        head: { sha: 'abc' },
      },
      repository: { full_name: 'test/repo', owner: { login: 'test' }, name: 'repo' },
      installation: { id: 123 },
    };

    const project = { id: 'p1', status: 'ACTIVE' };

    it('should reject PR if project is locked', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1', status: 'LOCKED' });
      await handler.handle(defaultPayload);
      expect(mockPrismaService.pullRequest.upsert).not.toHaveBeenCalled();
    });

    it('should persist PR indicating INVALID if no task found', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue(project);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });
      
      const payloadNoTask = JSON.parse(JSON.stringify(defaultPayload));
      payloadNoTask.pull_request.title = 'No task here';
      
      await handler.handle(payloadNoTask);
      
      expect(mockPrismaService.pullRequest.upsert).toHaveBeenCalledWith(expect.objectContaining({
        create: expect.objectContaining({ taskId: null }),
      }));
    });

    it('should FLAG if PR author is not assignee', async () => {
      mockPrismaService.project.findFirst.mockResolvedValue(project);
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });
      mockPrismaService.task.findUnique.mockResolvedValue({ id: 't1', assignee: { githubUserId: '999', name: 'Other' } });

      await handler.handle(defaultPayload);

      expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'TASK_REASSIGN' })
      }));
    });
  });
});
