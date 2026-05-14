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
    task: { count: jest.fn() },
    pullRequest: { count: jest.fn() },
    prReview: { count: jest.fn() },
    contributionScore: { count: jest.fn() },
    scoreOverride: { count: jest.fn() },
    contributionEvent: { count: jest.fn() },
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    project: { findFirst: jest.fn(), create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const githubService = {
    repositoryExists: jest.fn(),
    projectV2Exists: jest.fn(),
  };
  const configService = { get: jest.fn() };
  const usersService = { getGitHubAccessToken: jest.fn() };
  const projectAccessService = {
    assertCanManageProject: jest.fn(),
    assertCanViewProject: jest.fn(),
    assertCanCreateProjectInDepartment: jest.fn(),
  };
  const projectLockGuard = {
    assertMutable: jest.fn(),
  };
  const roleDelegationService = {
    assertTargetCanBeManaged: jest.fn(),
  };
  const userVisibilityService = {
    buildVisibleUserWhere: jest.fn(),
  };

  const service = new ProjectsService(
    prisma as any,
    githubService as any,
    configService as any,
    usersService as any,
    projectAccessService as any,
    projectLockGuard as any,
    roleDelegationService as any,
    userVisibilityService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    projectAccessService.assertCanManageProject.mockResolvedValue(undefined);
    projectAccessService.assertCanViewProject.mockResolvedValue(undefined);
    projectAccessService.assertCanCreateProjectInDepartment.mockResolvedValue(
      undefined,
    );
    projectLockGuard.assertMutable.mockReturnValue(undefined);
    roleDelegationService.assertTargetCanBeManaged.mockResolvedValue(undefined);
    userVisibilityService.buildVisibleUserWhere.mockReturnValue({});
    githubService.repositoryExists.mockResolvedValue(true);
    githubService.projectV2Exists.mockResolvedValue(true);
    usersService.getGitHubAccessToken.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    prisma.project.create.mockResolvedValue({ id: 'project-1' });
    prisma.projectMember.findUnique.mockResolvedValue(null);
    prisma.projectMember.upsert.mockResolvedValue({ id: 'member-1' });
    prisma.projectMember.delete.mockResolvedValue({ id: 'member-1' });
    prisma.task.count.mockResolvedValue(0);
    prisma.pullRequest.count.mockResolvedValue(0);
    prisma.prReview.count.mockResolvedValue(0);
    prisma.contributionScore.count.mockResolvedValue(0);
    prisma.scoreOverride.count.mockResolvedValue(0);
    prisma.contributionEvent.count.mockResolvedValue(0);
    prisma.auditLog.create.mockResolvedValue({});
  });

  describe('create', () => {
    const dto = {
      department_id: 'dept-1',
      name: 'Capstone',
      repository: 'owner/repo',
      github_project_id: 'PVT_1',
    };

    it('defaults the creator to project manager when no explicit manager is supplied', async () => {
      await service.create(dto, 'creator', ['DEPARTMENT_MANAGER'], 'gh-token');

      expect(prisma.project.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            members: {
              create: expect.objectContaining({
                userId: 'creator',
                role: 'PROJECT_MANAGER',
              }),
            },
          }) as unknown,
        }),
      );
      expect(
        roleDelegationService.assertTargetCanBeManaged,
      ).not.toHaveBeenCalled();
    });

    it('blocks assigning a protected target as project manager', async () => {
      roleDelegationService.assertTargetCanBeManaged.mockRejectedValueOnce(
        new ForbiddenException('protected target'),
      );

      await expect(
        service.create(
          { ...dto, project_manager_id: 'admin-user' },
          'teacher',
          ['DEPARTMENT_MANAGER'],
          'gh-token',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it('blocks project manager candidates outside actor visibility scope', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.create(
          { ...dto, project_manager_id: 'outside-user' },
          'teacher',
          ['DEPARTMENT_MANAGER'],
          'gh-token',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          AND: [{ id: 'outside-user' }, {}],
        },
        select: { id: true },
      });
      expect(prisma.project.create).not.toHaveBeenCalled();
    });
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

  it('allows removing a project member without project evidence', async () => {
    prisma.projectMember.findFirst.mockResolvedValueOnce({
      id: 'member-1',
      projectId: 'project-1',
      userId: 'student',
      role: 'PROJECT_MEMBER',
    });

    await expect(
      service.removeMember('project-1', 'member-1', 'manager', [
        'PROJECT_MANAGER',
      ]),
    ).resolves.toEqual({ id: 'member-1' });

    expect(prisma.projectMember.delete).toHaveBeenCalledWith({
      where: { id: 'member-1' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ROLE_CHANGE',
        actorId: 'manager',
        projectId: 'project-1',
        metadata: expect.objectContaining({
          operation: 'remove_project_member',
          targetUserId: 'student',
        }),
      }),
    });
  });

  it('blocks removing a project member with project evidence', async () => {
    prisma.projectMember.findFirst.mockResolvedValueOnce({
      id: 'member-1',
      projectId: 'project-1',
      userId: 'student',
      role: 'PROJECT_MEMBER',
    });
    prisma.task.count.mockResolvedValueOnce(2);

    await expect(
      service.removeMember('project-1', 'member-1', 'manager', [
        'PROJECT_MANAGER',
      ]),
    ).rejects.toThrow(ConflictException);

    expect(prisma.projectMember.delete).not.toHaveBeenCalled();
  });

  it('blocks project managers from locking projects at service level', async () => {
    await expect(
      service.lockProject('project-1', 'manager', ['PROJECT_MANAGER']),
    ).rejects.toThrow(ForbiddenException);
  });
});
