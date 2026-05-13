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
      create: jest.fn(),
      delete: jest.fn(),
    },
    projectMember: { findMany: jest.fn() },
    department: { findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const service = new RoleDelegationService(prisma as any);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.projectMember.findMany.mockResolvedValue([]);
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
});
