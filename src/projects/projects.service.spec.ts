import { ConflictException, ForbiddenException } from '@nestjs/common';

jest.mock('../github/github.service', () => ({
  GitHubService: class GitHubService {},
}));

import { ProjectsService } from './projects.service';

describe('ProjectsService project membership', () => {
  const prisma = {
    projectMember: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    project: { findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const projectAccessService = {
    assertCanManageProject: jest.fn(),
    assertCanViewProject: jest.fn(),
  };

  const service = new ProjectsService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    projectAccessService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    projectAccessService.assertCanManageProject.mockResolvedValue(undefined);
    projectAccessService.assertCanViewProject.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.projectMember.upsert.mockResolvedValue({ id: 'member-1' });
    prisma.auditLog.create.mockResolvedValue({});
  });

  it('allows project managers to add project members', async () => {
    await expect(
      service.upsertMember('project-1', 'user-1', 'PROJECT_MEMBER', 'manager', [
        'PROJECT_MANAGER',
      ]),
    ).resolves.toEqual({ id: 'member-1' });

    expect(prisma.projectMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          projectId: 'project-1',
          userId: 'user-1',
          role: 'PROJECT_MEMBER',
          source: 'MANUAL',
          createdBy: 'manager',
        }),
      }),
    );
  });

  it('blocks project managers from assigning another project manager', async () => {
    await expect(
      service.upsertMember(
        'project-1',
        'user-1',
        'PROJECT_MANAGER',
        'manager',
        ['PROJECT_MANAGER'],
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows department managers to assign project managers in managed projects', async () => {
    prisma.project.findFirst.mockResolvedValueOnce({ id: 'project-1' });

    await expect(
      service.upsertMember(
        'project-1',
        'user-1',
        'PROJECT_MANAGER',
        'teacher',
        ['DEPARTMENT_MANAGER'],
      ),
    ).resolves.toEqual({ id: 'member-1' });
  });

  it('blocks project managers from demoting another project manager', async () => {
    prisma.projectMember.findUnique.mockResolvedValueOnce({
      id: 'member-2',
      projectId: 'project-1',
      userId: 'user-1',
      role: 'PROJECT_MANAGER',
    });

    await expect(
      service.upsertMember('project-1', 'user-1', 'PROJECT_MEMBER', 'manager', [
        'PROJECT_MANAGER',
      ]),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.projectMember.upsert).not.toHaveBeenCalled();
  });

  it('prevents removing the last project manager', async () => {
    prisma.projectMember.findFirst.mockResolvedValueOnce({
      id: 'member-1',
      projectId: 'project-1',
      userId: 'manager',
      role: 'PROJECT_MANAGER',
    });
    prisma.projectMember.count.mockResolvedValueOnce(0);

    await expect(
      service.removeMember('project-1', 'member-1', 'admin', ['ADMIN']),
    ).rejects.toThrow(ConflictException);
  });

  it('blocks project managers from locking projects at service level', async () => {
    await expect(
      service.lockProject('project-1', 'manager', ['PROJECT_MANAGER']),
    ).rejects.toThrow(ForbiddenException);
  });
});
