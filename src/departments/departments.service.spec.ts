import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DepartmentsService } from './departments.service';

describe('DepartmentsService', () => {
  const prisma = {
    $transaction: jest.fn(),
    department: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    userRole: { create: jest.fn(), findFirst: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const departmentAccessService = {
    assertCanCreateDepartment: jest.fn(),
    buildAccessibleDepartmentWhere: jest.fn(),
    assertCanViewDepartment: jest.fn(),
    assertCanManageDepartment: jest.fn(),
  };

  const projectAccessService = {
    buildAccessibleProjectWhere: jest.fn(),
  };
  const roleDelegationService = {
    assertTargetCanBeManaged: jest.fn(),
  };

  let service: DepartmentsService;

  beforeEach(() => {
    jest.clearAllMocks();
    departmentAccessService.buildAccessibleDepartmentWhere.mockReturnValue({
      id: 'visible',
    });
    projectAccessService.buildAccessibleProjectWhere.mockReturnValue({
      id: 'project-visible',
    });
    roleDelegationService.assertTargetCanBeManaged.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    service = new DepartmentsService(
      prisma as any,
      departmentAccessService as any,
      projectAccessService as any,
      roleDelegationService as any,
    );
  });

  it('checks create permission against the target organization', async () => {
    prisma.department.create.mockResolvedValue({ id: 'dept-1' });

    await service.create(
      {
        name: 'Computer Science',
        organization_id: 'org-1',
        description: 'CS',
      },
      'actor',
      ['ORGANIZATION_MANAGER'],
    );

    expect(
      departmentAccessService.assertCanCreateDepartment,
    ).toHaveBeenCalledWith('actor', ['ORGANIZATION_MANAGER'], 'org-1');
  });

  it('creates the selected department manager role in the same transaction', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'manager-1' });
    prisma.user.findFirst.mockResolvedValue({ id: 'manager-1' });
    prisma.department.create.mockResolvedValue({ id: 'dept-1' });

    await service.create(
      {
        name: 'Computer Science',
        organization_id: 'org-1',
        description: 'CS',
        manager_user_id: 'manager-1',
      },
      'actor',
      ['ORGANIZATION_MANAGER'],
    );

    expect(
      departmentAccessService.assertCanCreateDepartment,
    ).toHaveBeenCalledWith('actor', ['ORGANIZATION_MANAGER'], 'org-1');
    expect(roleDelegationService.assertTargetCanBeManaged).toHaveBeenCalledWith(
      'actor',
      ['ORGANIZATION_MANAGER'],
      'manager-1',
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: 'manager-1' },
          {
            OR: [
              { userRoles: { some: { organizationId: 'org-1' } } },
              {
                userRoles: {
                  some: { department: { organizationId: 'org-1' } },
                },
              },
              {
                projectMembers: {
                  some: {
                    project: {
                      department: { organizationId: 'org-1' },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
      select: { id: true },
    });
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: {
        userId: 'manager-1',
        role: 'DEPARTMENT_MANAGER',
        departmentId: 'dept-1',
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'ROLE_CHANGE',
        actorId: 'actor',
        metadata: {
          operation: 'assign',
          targetUserId: 'manager-1',
          role: 'DEPARTMENT_MANAGER',
          departmentId: 'dept-1',
        },
      },
    });
  });

  it('rejects a selected department manager outside the target organization', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'manager-1' });
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.create(
        {
          name: 'Computer Science',
          organization_id: 'org-1',
          manager_user_id: 'manager-1',
        },
        'actor',
        ['ORGANIZATION_MANAGER'],
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.department.create).not.toHaveBeenCalled();
  });

  it('returns department managers in department lists', async () => {
    prisma.department.findMany.mockResolvedValue([]);

    await service.findAll('actor', ['ORGANIZATION_MANAGER']);

    expect(prisma.department.findMany).toHaveBeenCalledWith({
      where: { id: 'visible' },
      include: {
        organization: true,
        userRoles: expect.objectContaining({
          where: { role: 'DEPARTMENT_MANAGER' },
          include: expect.objectContaining({
            user: expect.any(Object),
          }),
        }),
        _count: {
          select: { projects: true },
        },
      },
    });
  });

  it('combines department search with scoped access filter', async () => {
    prisma.department.findMany.mockResolvedValue([]);

    await service.findAll('actor', ['ORGANIZATION_MANAGER'], 'org-1', 'Ada');

    expect(
      departmentAccessService.buildAccessibleDepartmentWhere,
    ).toHaveBeenCalledWith('actor', ['ORGANIZATION_MANAGER'], 'org-1');
    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { id: 'visible' },
            expect.objectContaining({
              OR: expect.arrayContaining([
                {
                  name: {
                    contains: 'Ada',
                    mode: 'insensitive',
                  },
                },
                {
                  description: {
                    contains: 'Ada',
                    mode: 'insensitive',
                  },
                },
                expect.objectContaining({
                  organization: expect.objectContaining({
                    name: {
                      contains: 'Ada',
                      mode: 'insensitive',
                    },
                  }),
                }),
                expect.objectContaining({
                  userRoles: expect.objectContaining({
                    some: expect.objectContaining({
                      role: 'DEPARTMENT_MANAGER',
                    }),
                  }),
                }),
              ]),
            }),
          ],
        },
      }),
    );
  });

  it('checks target organization permission when moving a department', async () => {
    prisma.department.update.mockResolvedValue({ id: 'dept-1' });
    prisma.department.findUnique
      .mockResolvedValueOnce({ id: 'dept-1', organizationId: 'org-1' })
      .mockResolvedValueOnce({ id: 'dept-1' });

    await service.update(
      'dept-1',
      { name: 'Updated', organization_id: 'org-2' },
      'actor',
      ['ORGANIZATION_MANAGER'],
    );

    expect(
      departmentAccessService.assertCanManageDepartment,
    ).toHaveBeenCalledWith('actor', ['ORGANIZATION_MANAGER'], 'dept-1');
    expect(
      departmentAccessService.assertCanCreateDepartment,
    ).toHaveBeenCalledWith('actor', ['ORGANIZATION_MANAGER'], 'org-2');
    expect(prisma.department.update).toHaveBeenCalledWith({
      where: { id: 'dept-1' },
      data: {
        name: 'Updated',
        organizationId: 'org-2',
        description: undefined,
      },
    });
  });

  it('adds the selected department manager while updating department fields', async () => {
    prisma.department.findUnique
      .mockResolvedValueOnce({ id: 'dept-1', organizationId: 'org-1' })
      .mockResolvedValueOnce({ id: 'dept-1' });
    prisma.department.update.mockResolvedValue({ id: 'dept-1' });
    prisma.user.findUnique.mockResolvedValue({ id: 'manager-2' });
    prisma.user.findFirst.mockResolvedValue({ id: 'manager-2' });
    prisma.userRole.findFirst.mockResolvedValue(null);

    await service.update(
      'dept-1',
      {
        name: 'Updated',
        description: 'Updated description',
        manager_user_id: 'manager-2',
      },
      'actor',
      ['ORGANIZATION_MANAGER'],
    );

    expect(
      departmentAccessService.assertCanCreateDepartment,
    ).toHaveBeenCalledWith('actor', ['ORGANIZATION_MANAGER'], 'org-1');
    expect(roleDelegationService.assertTargetCanBeManaged).toHaveBeenCalledWith(
      'actor',
      ['ORGANIZATION_MANAGER'],
      'manager-2',
    );
    expect(prisma.userRole.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'manager-2',
        role: 'DEPARTMENT_MANAGER',
        departmentId: 'dept-1',
      },
      select: { id: true },
    });
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: {
        userId: 'manager-2',
        role: 'DEPARTMENT_MANAGER',
        departmentId: 'dept-1',
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'ROLE_CHANGE',
        actorId: 'actor',
        metadata: {
          operation: 'assign',
          targetUserId: 'manager-2',
          role: 'DEPARTMENT_MANAGER',
          departmentId: 'dept-1',
        },
      },
    });
  });

  it('blocks department managers from assigning another department manager through edit', async () => {
    prisma.department.findUnique.mockResolvedValue({
      id: 'dept-1',
      organizationId: 'org-1',
    });
    departmentAccessService.assertCanCreateDepartment.mockRejectedValueOnce(
      new ForbiddenException('You do not have permission to create departments'),
    );

    await expect(
      service.update(
        'dept-1',
        { manager_user_id: 'manager-2' },
        'actor',
        ['DEPARTMENT_MANAGER'],
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.department.update).not.toHaveBeenCalled();
    expect(prisma.userRole.create).not.toHaveBeenCalled();
  });

  it('deletes an empty department after access check', async () => {
    prisma.department.findUnique.mockResolvedValue({
      id: 'dept-1',
      _count: { projects: 0, userRoles: 0 },
    });
    prisma.department.delete.mockResolvedValue({ id: 'dept-1' });

    await service.remove('dept-1', 'actor', ['ORGANIZATION_MANAGER']);

    expect(
      departmentAccessService.assertCanManageDepartment,
    ).toHaveBeenCalledWith('actor', ['ORGANIZATION_MANAGER'], 'dept-1');
    expect(prisma.department.findUnique).toHaveBeenCalledWith({
      where: { id: 'dept-1' },
      include: {
        _count: {
          select: {
            projects: true,
            userRoles: true,
          },
        },
      },
    });
    expect(prisma.department.delete).toHaveBeenCalledWith({
      where: { id: 'dept-1' },
    });
  });

  it('blocks deleting a department with dependent data', async () => {
    prisma.department.findUnique.mockResolvedValue({
      id: 'dept-1',
      _count: { projects: 1, userRoles: 0 },
    });

    await expect(
      service.remove('dept-1', 'actor', ['ORGANIZATION_MANAGER']),
    ).rejects.toThrow(ConflictException);
    expect(prisma.department.delete).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when deleting a missing department', async () => {
    prisma.department.findUnique.mockResolvedValue(null);

    await expect(
      service.remove('missing', 'actor', ['ORGANIZATION_MANAGER']),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.department.delete).not.toHaveBeenCalled();
  });
});
