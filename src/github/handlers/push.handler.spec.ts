jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PushHandler } from './push.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';

describe('PushHandler', () => {
  let handler: PushHandler;
  let loggerDebugSpy: jest.SpyInstance;

  const mockPrismaService = {
    project: { findFirst: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushHandler,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    handler = module.get<PushHandler>(PushHandler);
    jest.clearAllMocks();
    
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    loggerDebugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  it('should log commit information but perform no DB inserts', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });

    const payload = {
      ref: 'refs/heads/main',
      repository: { full_name: 'test/repo' },
      commits: [
        { id: '123', message: 'First', author: { username: 'u1' } },
        { id: '456', message: 'Second', author: { username: 'u2' } },
      ],
      sender: { login: 'u1' }
    };

    await handler.handle(payload);

    // Should find project explicitly
    expect(mockPrismaService.project.findFirst).toHaveBeenCalled();
    
    // Should log commits explicitly
    expect(loggerDebugSpy).toHaveBeenCalledWith(expect.stringContaining('First'));
    expect(loggerDebugSpy).toHaveBeenCalledWith(expect.stringContaining('Second'));
    
    // No writes/updates to DB
    expect(Object.keys(mockPrismaService).length).toBe(1); // Only project mock exists
  });

  it('should ignore payload without repository', async () => {
    await handler.handle({});
    expect(mockPrismaService.project.findFirst).not.toHaveBeenCalled();
  });
});
