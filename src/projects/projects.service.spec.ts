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
    department: { findUnique: jest.fn() },
    project: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const githubService = {
    getRepositoryInfo: jest.fn(),
    repositoryExists: jest.fn(),
    projectV2Exists: jest.fn(),
    isCollaborator: jest.fn(),
  };
  const configService = { get: jest.fn() };
  const usersService = { getGitHubAccessToken: jest.fn() };
  const projectAccessService = {
    assertCanManageProject: jest.fn(),
    assertCanViewProject: jest.fn(),
    assertCanCreateProjectInDepartment: jest.fn(),
    buildAccessibleProjectWhere: jest.fn(),
    buildManageableProjectWhere: jest.fn(),
    canManageProject: jest.fn(),
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
    configService.get.mockImplementation((key: string) => {
      if (key === 'GITHUB_TOKEN_ENCRYPTION_KEY' || key === 'JWT_SECRET') {
        return 'test-encryption-key-32-chars-long';
      }
      return null;
    });
    projectAccessService.assertCanManageProject.mockResolvedValue(undefined);
    projectAccessService.assertCanViewProject.mockResolvedValue(undefined);
    projectAccessService.assertCanCreateProjectInDepartment.mockResolvedValue(
      undefined,
    );
    projectAccessService.canManageProject.mockResolvedValue(true);
    projectLockGuard.assertMutable.mockReturnValue(undefined);
    roleDelegationService.assertTargetCanBeManaged.mockResolvedValue(undefined);
    userVisibilityService.buildVisibleUserWhere.mockReturnValue({});
    projectAccessService.buildAccessibleProjectWhere.mockReturnValue({
      id: 'visible',
    });
    projectAccessService.buildManageableProjectWhere.mockReturnValue({});
    githubService.getRepositoryInfo.mockResolvedValue({
      id: 'repo-1',
      nameWithOwner: 'owner/repo',
      url: 'https://github.com/owner/repo',
    });
    githubService.repositoryExists.mockResolvedValue(true);
    githubService.projectV2Exists.mockResolvedValue(true);
    githubService.isCollaborator.mockResolvedValue(true);
    usersService.getGitHubAccessToken.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', githubUsername: 'student-lead', name: 'Student' });
    prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
    prisma.department.findUnique.mockResolvedValue({
      id: 'dept-1',
      organizationId: 'org-1',
    });
    // Multiple call sites use prisma.project.findUnique with different
    // shapes. Discriminate by the where clause so each path gets the right
    // shape: the repository-conflict check needs null; the org-scope
    // lookup in upsertMember needs the department.organizationId.
    prisma.project.findUnique.mockImplementation(({ where }: any) => {
      if (where?.githubRepositoryId) return Promise.resolve(null);
      if (where?.id) {
        return Promise.resolve({
          department: { organizationId: 'org-1' },
        });
      }
      return Promise.resolve(null);
    });
    prisma.project.findFirst.mockResolvedValue({ id: 'project-1' });
    prisma.project.findMany.mockResolvedValue([]);
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

  it('combines project search with scoped access filter', async () => {
    await service.findAll('dept-1', 'actor', ['PROJECT_MEMBER'], 'locked');

    expect(projectAccessService.buildAccessibleProjectWhere).toHaveBeenCalledWith(
      'actor',
      ['PROJECT_MEMBER'],
      'dept-1',
    );
    expect(prisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { id: 'visible' },
            expect.objectContaining({
              OR: expect.arrayContaining([
                {
                  name: {
                    contains: 'locked',
                    mode: 'insensitive',
                  },
                },
                {
                  repository: {
                    contains: 'locked',
                    mode: 'insensitive',
                  },
                },
                expect.objectContaining({
                  department: expect.objectContaining({
                    OR: expect.any(Array),
                  }),
                }),
                { status: { in: ['LOCKED'] } },
              ]),
            }),
          ],
        },
      }),
    );
  });

  describe('create', () => {
    const dto = {
      department_id: 'dept-1',
      name: 'Capstone',
      repository: 'owner/repo',
      github_project_id: 'PVT_1',
      project_lead_id: 'lead-1',
    };

    it('defaults the creator to project manager when no explicit manager is supplied', async () => {
      await service.create(dto, 'creator', ['DEPARTMENT_MANAGER'], 'gh-token');

      expect(prisma.project.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            members: {
              create: expect.arrayContaining([
                expect.objectContaining({
                  userId: 'creator',
                  role: 'PROJECT_MANAGER',
                }),
                expect.objectContaining({
                  userId: 'lead-1',
                  role: 'PROJECT_LEAD',
                }),
              ]),
            },
          }) as unknown,
        }),
      );
      expect(
        roleDelegationService.assertTargetCanBeManaged,
      ).not.toHaveBeenCalled();
    });

    it('normalizes repository names before validation and storage', async () => {
      await service.create(
        { ...dto, repository: 'Owner/Repo' },
        'creator',
        ['DEPARTMENT_MANAGER'],
        'gh-token',
      );

      expect(githubService.getRepositoryInfo).toHaveBeenCalledWith(
        'owner',
        'repo',
        'gh-token',
      );
      expect(prisma.project.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            repository: 'owner/repo',
            githubRepositoryId: 'repo-1',
          }) as unknown,
        }),
      );
    });

    it('returns a conflict when the GitHub repository is already linked to a project', async () => {
      prisma.project.findUnique.mockResolvedValueOnce({
        id: 'existing-project',
        name: 'Existing Capstone',
      });
      prisma.project.findFirst.mockResolvedValueOnce({
        id: 'existing-project',
      });

      await expect(
        service.create(dto, 'creator', ['DEPARTMENT_MANAGER'], 'gh-token'),
      ).rejects.toThrow(
        'A project already exists for this GitHub repository: Existing Capstone',
      );

      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it('does not reveal the existing project name when the actor cannot access it', async () => {
      prisma.project.findUnique.mockResolvedValueOnce({
        id: 'hidden-project',
        name: 'Private Capstone',
      });
      prisma.project.findFirst.mockResolvedValueOnce(null);

      const error = await service
        .create(dto, 'creator', ['DEPARTMENT_MANAGER'], 'gh-token')
        .catch((err) => err);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toBe(
        'A project already exists for this GitHub repository',
      );
      expect(error.message).not.toContain('Private Capstone');
    });

    it('returns a conflict if the repository unique constraint is hit during create', async () => {
      prisma.project.create.mockRejectedValueOnce({
        code: 'P2002',
        meta: { target: ['githubRepositoryId'] },
      });

      await expect(
        service.create(dto, 'creator', ['DEPARTMENT_MANAGER'], 'gh-token'),
      ).rejects.toThrow('A project already exists for this GitHub repository');
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

  describe('assertUserBelongsToProjectOrganization (via create + upsertMember)', () => {
    const createDto = {
      department_id: 'dept-1',
      name: 'Capstone',
      repository: 'owner/repo',
      github_project_id: 'PVT_1',
      project_lead_id: 'lead-1',
    };

    /**
     * The service issues two distinct prisma.user.findFirst calls:
     * - Visibility check  → `where: { AND: [{ id }, <visibility clause>] }`
     * - Affiliation check → `where: { id, OR: [...] }`
     *
     * This helper builds a mockImplementation that lets the test author
     * declare which user IDs are affiliated; visibility always passes.
     */
    function setupFindFirst(affiliatedIds: Set<string>) {
      prisma.user.findFirst.mockImplementation(({ where }: any) => {
        if (where?.AND) {
          // Visibility check — always say yes
          const id = where.AND[0].id;
          return Promise.resolve({ id });
        }
        if (where?.OR && where?.id) {
          return Promise.resolve(
            affiliatedIds.has(where.id) ? { id: where.id } : null,
          );
        }
        return Promise.resolve({ id: where?.id ?? 'unknown' });
      });
    }

    it('rejects creating a project when the project lead is not affiliated with the org', async () => {
      // Project lead id resolves to 'user-1' (from prisma.user.findUnique default).
      // Mark no one as affiliated; the project-lead affiliation check fails.
      // PM defaults to actor 'creator' → bypassed via self.
      setupFindFirst(new Set());

      await expect(
        service.create(createDto, 'creator', ['ORGANIZATION_MANAGER'], 'gh-token'),
      ).rejects.toThrow(/not affiliated/i);
      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it('accepts creation when both PM (self) and PL are affiliated', async () => {
      // PL id ('user-1' per the mock) is affiliated → check passes.
      setupFindFirst(new Set(['user-1']));

      await expect(
        service.create(createDto, 'creator', ['ORGANIZATION_MANAGER'], 'gh-token'),
      ).resolves.toBeDefined();
      expect(prisma.project.create).toHaveBeenCalled();
    });

    it('rejects upserting a project member when the target user is not affiliated', async () => {
      setupFindFirst(new Set()); // nobody affiliated

      await expect(
        service.upsertMember(
          'project-1',
          'outside-user',
          'PROJECT_MEMBER',
          'manager',
          ['PROJECT_MANAGER'],
        ),
      ).rejects.toThrow(/not affiliated/i);
      expect(prisma.projectMember.upsert).not.toHaveBeenCalled();
    });

    it('bypasses the affiliation check for ADMIN actors', async () => {
      // No one affiliated, but admin is bypassed inside the assertion.
      setupFindFirst(new Set());

      await expect(
        service.create(createDto, 'admin', ['ADMIN'], 'gh-token'),
      ).resolves.toBeDefined();
      expect(prisma.project.create).toHaveBeenCalled();
    });

    it('bypasses the affiliation check for self-assignment (actorId === userId)', async () => {
      // PM = creator (self → bypassed). PL = 'user-1' is affiliated.
      setupFindFirst(new Set(['user-1']));

      await expect(
        service.create(
          { ...createDto, project_manager_id: 'creator' },
          'creator',
          ['ORGANIZATION_MANAGER'],
          'gh-token',
        ),
      ).resolves.toBeDefined();
    });
  });
});
