jest.mock('@octokit/graphql', () => ({
  graphql: Object.assign(jest.fn(), {
    defaults: jest.fn().mockReturnValue(jest.fn()),
  }),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn().mockReturnValue(jest.fn().mockResolvedValue({ token: 'mock-token' })),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ProjectMetadataHandler } from './project-metadata.handler';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';

describe('ProjectMetadataHandler', () => {
  let handler: ProjectMetadataHandler;

  const mockPrismaService = {
    project: { findFirst: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectMetadataHandler,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    handler = module.get<ProjectMetadataHandler>(ProjectMetadataHandler);
    jest.clearAllMocks();
    
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  const basePayload = {
    projects_v2: { node_id: 'pn1' },
    sender: { id: 1, login: 'user1' },
  };

  it('should sync project title on edit', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1', name: 'Old Title' });

    const payload = {
      ...basePayload,
      action: 'edited',
      projects_v2: { 
        ...basePayload.projects_v2, 
        title: 'New Title',
        changes: { title: { to: 'New Title' } }
      },
    };

    await handler.handle(payload);

    expect(mockPrismaService.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { name: 'New Title' }
    });
  });

  it('should set project to ARCHIVED on delete', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1', status: 'ACTIVE' });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });

    await handler.handle({ ...basePayload, action: 'deleted' });

    expect(mockPrismaService.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: 'ARCHIVED' }
    });
    
    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'PROJECT_LOCK' })
    }));
  });

  it('should set project to LOCKED on close', async () => {
    mockPrismaService.project.findFirst.mockResolvedValue({ id: 'p1' });
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 'u1' });

    await handler.handle({ ...basePayload, action: 'closed' });

    expect(mockPrismaService.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ status: 'LOCKED' })
    });

    expect(mockPrismaService.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'PROJECT_LOCK' })
    }));
  });
});
