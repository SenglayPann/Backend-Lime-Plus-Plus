import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { RoleDelegationService } from './role-delegation.service';

describe('RoleDelegationService', () => {
  const prisma = {
    userRole: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    projectMember: { findMany: jest.fn() },
    department: { findFirst: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const service = new RoleDelegationService(prisma as any);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.projectMember.findMany.mockResolvedValue([]);
    // Default: orphan-prevention invariants are satisfied (other managers exist).
    prisma.userRole.count.mockResolvedValue(1);
  });

  it('allows admin to assign organization manager with organization scope', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce(null);
    prisma.userRole.create.mockResolvedValueOnce({ id: 'role-1' });

    await expect(
      service.assignUserRole(
        'admin',
        ['ADMIN'],
        'target',
        'ORGANIZATION_MANAGER',
        'org-1',
      ),
    ).resolves.toEqual({ id: 'role-1' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'ROLE_CHANGE',
          actorId: 'admin',
        }),
      }),
    );
  });

  it('allows organization manager to assign department manager inside managed organization', async () => {
    prisma.department.findFirst.mockResolvedValueOnce({ id: 'dept-1' });
    prisma.userRole.findFirst.mockResolvedValueOnce(null);
    prisma.userRole.create.mockResolvedValueOnce({ id: 'role-1' });

    await expect(
      service.assignUserRole(
        'org-manager',
        ['ORGANIZATION_MANAGER'],
        'target',
        'DEPARTMENT_MANAGER',
        undefined,
        'dept-1',
      ),
    ).resolves.toEqual({ id: 'role-1' });
  });

  it('blocks organization manager from assigning admin', async () => {
    await expect(
      service.assignUserRole(
        'org-manager',
        ['ORGANIZATION_MANAGER'],
        'target',
        'ADMIN',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects project roles in user_roles', async () => {
    await expect(
      service.assignUserRole('admin', ['ADMIN'], 'target', 'PROJECT_MANAGER'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects organization manager role with department scope', async () => {
    await expect(
      service.assignUserRole(
        'admin',
        ['ADMIN'],
        'target',
        'ORGANIZATION_MANAGER',
        'org-1',
        'dept-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects department manager role with organization scope', async () => {
    await expect(
      service.assignUserRole(
        'admin',
        ['ADMIN'],
        'target',
        'DEPARTMENT_MANAGER',
        'org-1',
        'dept-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects organization member role without organization scope', async () => {
    await expect(
      service.assignUserRole(
        'admin',
        ['ADMIN'],
        'target',
        'ORGANIZATION_MEMBER',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows organization manager to assign organization member inside managed organization', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce({ id: 'org-mgr-role' }); // assertActorManagesOrganization
    prisma.userRole.findFirst.mockResolvedValueOnce(null); // existing role check
    prisma.userRole.create.mockResolvedValueOnce({ id: 'org-member-role' });

    await expect(
      service.assignUserRole(
        'org-manager',
        ['ORGANIZATION_MANAGER'],
        'target',
        'ORGANIZATION_MEMBER',
        'org-1',
      ),
    ).resolves.toEqual({ id: 'org-member-role' });
  });

  it('blocks duplicate scoped role assignment', async () => {
    prisma.userRole.findFirst.mockResolvedValueOnce({ id: 'existing-role' });

    await expect(
      service.assignUserRole(
        'admin',
        ['ADMIN'],
        'target',
        'ORGANIZATION_MANAGER',
        'org-1',
      ),
    ).rejects.toThrow(ConflictException);
  });

  describe('removeUserRole orphan-prevention invariants', () => {
    it('blocks removing the last ADMIN', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'admin-role-1',
        userId: 'admin-1',
        role: 'ADMIN',
        organizationId: null,
        departmentId: null,
      });
      prisma.userRole.count.mockResolvedValueOnce(0); // no other admin exists

      await expect(
        service.removeUserRole('admin-1', ['ADMIN'], 'admin-role-1'),
      ).rejects.toThrow(/at least one administrator/i);
      expect(prisma.userRole.count).toHaveBeenCalledWith({
        where: { role: 'ADMIN', id: { not: 'admin-role-1' } },
      });
      expect(prisma.userRole.delete).not.toHaveBeenCalled();
    });

    it('allows removing an ADMIN when another remains', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'admin-role-1',
        userId: 'admin-1',
        role: 'ADMIN',
        organizationId: null,
        departmentId: null,
      });
      prisma.userRole.count.mockResolvedValueOnce(2); // other admins exist
      prisma.userRole.delete.mockResolvedValueOnce({ id: 'admin-role-1' });

      await expect(
        service.removeUserRole('admin-2', ['ADMIN'], 'admin-role-1'),
      ).resolves.toEqual({ id: 'admin-role-1' });
      expect(prisma.userRole.delete).toHaveBeenCalledWith({
        where: { id: 'admin-role-1' },
      });
    });

    it('blocks an ADMIN from self-removing as the last administrator', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'admin-role-1',
        userId: 'admin-1',
        role: 'ADMIN',
        organizationId: null,
        departmentId: null,
      });
      prisma.userRole.count.mockResolvedValueOnce(0);

      await expect(
        service.removeUserRole('admin-1', ['ADMIN'], 'admin-role-1'),
      ).rejects.toThrow(/at least one administrator/i);
    });

    it('blocks removing the last ORGANIZATION_MANAGER of an org', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'org-mgr-role-1',
        userId: 'user-1',
        role: 'ORGANIZATION_MANAGER',
        organizationId: 'org-1',
        departmentId: null,
      });
      prisma.userRole.count.mockResolvedValueOnce(0);

      await expect(
        service.removeUserRole('admin', ['ADMIN'], 'org-mgr-role-1'),
      ).rejects.toThrow(/at least one organization manager/i);
      expect(prisma.userRole.count).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          role: 'ORGANIZATION_MANAGER',
          id: { not: 'org-mgr-role-1' },
        },
      });
      expect(prisma.userRole.delete).not.toHaveBeenCalled();
    });

    it('allows removing an ORGANIZATION_MANAGER when another remains in the org', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'org-mgr-role-1',
        userId: 'user-1',
        role: 'ORGANIZATION_MANAGER',
        organizationId: 'org-1',
        departmentId: null,
      });
      prisma.userRole.count.mockResolvedValueOnce(1);
      prisma.userRole.delete.mockResolvedValueOnce({ id: 'org-mgr-role-1' });

      await expect(
        service.removeUserRole('admin', ['ADMIN'], 'org-mgr-role-1'),
      ).resolves.toEqual({ id: 'org-mgr-role-1' });
    });

    it('blocks removing the last DEPARTMENT_MANAGER of a department', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'dept-mgr-role-1',
        userId: 'user-1',
        role: 'DEPARTMENT_MANAGER',
        organizationId: null,
        departmentId: 'dept-1',
      });
      prisma.userRole.count.mockResolvedValueOnce(0);

      await expect(
        service.removeUserRole('admin', ['ADMIN'], 'dept-mgr-role-1'),
      ).rejects.toThrow(/at least one department manager/i);
      expect(prisma.userRole.count).toHaveBeenCalledWith({
        where: {
          departmentId: 'dept-1',
          role: 'DEPARTMENT_MANAGER',
          id: { not: 'dept-mgr-role-1' },
        },
      });
      expect(prisma.userRole.delete).not.toHaveBeenCalled();
    });

    it('allows removing a DEPARTMENT_MANAGER when another remains in the dept', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'dept-mgr-role-1',
        userId: 'user-1',
        role: 'DEPARTMENT_MANAGER',
        organizationId: null,
        departmentId: 'dept-1',
      });
      prisma.department.findFirst.mockResolvedValueOnce({ id: 'dept-1' }); // org-manager scope check
      prisma.userRole.count.mockResolvedValueOnce(1);
      prisma.userRole.delete.mockResolvedValueOnce({ id: 'dept-mgr-role-1' });

      await expect(
        service.removeUserRole(
          'org-mgr',
          ['ORGANIZATION_MANAGER'],
          'dept-mgr-role-1',
        ),
      ).resolves.toEqual({ id: 'dept-mgr-role-1' });
    });

    it('does not run any invariant query for ORGANIZATION_MEMBER removals', async () => {
      prisma.userRole.findUnique.mockResolvedValueOnce({
        id: 'org-member-role-1',
        userId: 'user-1',
        role: 'ORGANIZATION_MEMBER',
        organizationId: 'org-1',
        departmentId: null,
      });
      prisma.userRole.findFirst.mockResolvedValueOnce({ id: 'actor-org-mgr' });
      prisma.userRole.delete.mockResolvedValueOnce({ id: 'org-member-role-1' });

      await expect(
        service.removeUserRole(
          'org-mgr',
          ['ORGANIZATION_MANAGER'],
          'org-member-role-1',
        ),
      ).resolves.toEqual({ id: 'org-member-role-1' });
      expect(prisma.userRole.count).not.toHaveBeenCalled();
    });
  });
});
