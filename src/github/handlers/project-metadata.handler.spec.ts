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
import { ProjectMetadataHandler } from './project-metadata.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';
import { ProjectLockGuardService } from '../../common/access/project-lock-guard.service';

import { GitHubProjectV2EventPayload } from '../github-payloads';

describe('ProjectMetadataHandler', () => {
  let handler: ProjectMetadataHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
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
        ProjectMetadataHandler,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ProjectLockGuardService, useValue: mockProjectLockGuard },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    handler = module.get<ProjectMetadataHandler>(ProjectMetadataHandler);
    jest.clearAllMocks();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    mockProjectLockGuard.isLocked.mockReturnValue(false);
  });

  const basePayload = {
    action: 'edited',
    projects_v2: {
      node_id: 'pn1',
      id: 1,
      title: 'Project',
      owner: { id: 1, login: 'owner' },
      creator: { id: 1, login: 'creator' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      number: 1,
    },
    sender: { id: 1, login: 'user1' },
    organization: { id: 1, login: 'org' },
  } as unknown as GitHubProjectV2EventPayload;

  it('should sync project title on edit', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({
      id: 'p1',
      name: 'Old Title',
    });

    const payload = {
      ...basePayload,
      action: 'edited',
      projects_v2: {
        ...basePayload.projects_v2,
        title: 'New Title',
        changes: { title: { to: 'New Title' } },
      },
    } as GitHubProjectV2EventPayload;

    await handler.handle(payload);

    expect(mockPrismaService.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { name: 'New Title' },
    });
  });

  it('should set project to ARCHIVED on delete', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
    });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });

    await handler.handle({ ...basePayload, action: 'deleted' });

    expect(mockPrismaService.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: 'ARCHIVED' },
    });

    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PROJECT_LOCK' }) as unknown,
      }),
    );
  });

  it('should set project to LOCKED on close', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });

    await handler.handle({ ...basePayload, action: 'closed' });

    expect(mockPrismaService.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ status: 'LOCKED' }) as unknown,
    });

    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PROJECT_LOCK' }) as unknown,
      }),
    );
  });
});
