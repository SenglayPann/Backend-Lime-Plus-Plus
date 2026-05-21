import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';

describe('OrganizationsService', () => {
  const prisma = {
    $transaction: jest.fn(),
    organization: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    userRole: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };

  const organizationAccessService = {
    buildAccessibleOrganizationWhere: jest.fn(),
    assertCanViewOrganization: jest.fn(),
  };
  const departmentAccessService = {
    buildAccessibleDepartmentWhere: jest.fn(),
  };
  const roleDelegationService = {
    assertTargetCanBeManaged: jest.fn(),
  };

  let service: OrganizationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    organizationAccessService.buildAccessibleOrganizationWhere.mockReturnValue({
      id: 'visible',
    });
    departmentAccessService.buildAccessibleDepartmentWhere.mockReturnValue({
      id: 'department-visible',
    });
    roleDelegationService.assertTargetCanBeManaged.mockResolvedValue(undefined);
    prisma.organization.findFirst.mockResolvedValue(null);
    prisma.userRole.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    service = new OrganizationsService(
      prisma as any,
      organizationAccessService as any,
      departmentAccessService as any,
      roleDelegationService as any,
    );
  });

  it('creates an organization with license plan mapping', async () => {
    prisma.organization.create.mockResolvedValue({ id: 'org-1' });

    await service.create(
      { name: 'Engineering', license_plan: 'academic' },
      'admin',
      ['ADMIN'],
    );

    expect(prisma.organization.create).toHaveBeenCalledWith({
      data: {
        name: 'Engineering',
        licensePlan: 'academic',
      },
    });
  });

  it('rejects duplicate organization names before creating', async () => {
    prisma.organization.findFirst.mockResolvedValueOnce({ id: 'org-existing' });

    await expect(
      service.create(
        { name: 'Engineering', license_plan: 'academic' },
        'admin',
        ['ADMIN'],
      ),
    ).rejects.toThrow('An organization with this name already exists');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.organization.create).not.toHaveBeenCalled();
  });

  it('returns a conflict if the organization name unique index is hit during create', async () => {
    prisma.organization.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(
      service.create(
        { name: 'Engineering', license_plan: 'academic' },
        'admin',
        ['ADMIN'],
      ),
    ).rejects.toThrow('An organization with this name already exists');
  });

  it('creates the selected organization manager role in the same transaction', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'manager-1' });
    prisma.organization.create.mockResolvedValue({ id: 'org-1' });

    await service.create(
      {
        name: 'Engineering',
        license_plan: 'academic',
        manager_user_id: 'manager-1',
      },
      'admin',
      ['ADMIN'],
    );

    expect(roleDelegationService.assertTargetCanBeManaged).toHaveBeenCalledWith(
      'admin',
      ['ADMIN'],
      'manager-1',
    );
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: {
        userId: 'manager-1',
        role: 'ORGANIZATION_MANAGER',
        organizationId: 'org-1',
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'ROLE_CHANGE',
        actorId: 'admin',
        metadata: {
          operation: 'assign',
          targetUserId: 'manager-1',
          role: 'ORGANIZATION_MANAGER',
          organizationId: 'org-1',
        },
      },
    });
  });

  it('rejects a missing selected organization manager before creating the organization', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.create(
        {
          name: 'Engineering',
          license_plan: 'academic',
          manager_user_id: 'missing-user',
        },
        'admin',
        ['ADMIN'],
      ),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.organization.create).not.toHaveBeenCalled();
  });

  it('lists organizations through scoped access filter', async () => {
    prisma.organization.findMany.mockResolvedValue([]);

    await service.findAll('actor', ['ORGANIZATION_MANAGER']);

    expect(prisma.organization.findMany).toHaveBeenCalledWith({
      where: { id: 'visible' },
      include: {
        userRoles: expect.objectContaining({
          where: { role: 'ORGANIZATION_MANAGER' },
          include: expect.objectContaining({
            user: expect.any(Object),
          }),
        }),
        _count: {
          select: {
            departments: true,
            userRoles: true,
          },
        },
      },
    });
  });

  it('combines organization search with scoped access filter', async () => {
    prisma.organization.findMany.mockResolvedValue([]);

    await service.findAll('actor', ['ORGANIZATION_MANAGER'], 'Grace');

    expect(prisma.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { id: 'visible' },
            expect.objectContaining({
              OR: expect.arrayContaining([
                {
                  name: {
                    contains: 'Grace',
                    mode: 'insensitive',
                  },
                },
                {
                  licensePlan: {
                    contains: 'Grace',
                    mode: 'insensitive',
                  },
                },
                expect.objectContaining({
                  userRoles: expect.objectContaining({
                    some: expect.objectContaining({
                      role: 'ORGANIZATION_MANAGER',
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

  it('updates organization fields with license plan mapping', async () => {
    prisma.organization.update.mockResolvedValue({ id: 'org-1' });
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1' });

    await service.update(
      'org-1',
      {
        name: 'Updated',
        license_plan: 'enterprise',
      },
      'admin',
      ['ADMIN'],
    );

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: {
        name: 'Updated',
        licensePlan: 'enterprise',
      },
    });
  });

  it('rejects renaming an organization to a duplicate name', async () => {
    prisma.organization.findFirst.mockResolvedValueOnce({ id: 'org-existing' });

    await expect(
      service.update('org-1', { name: 'Engineering' }, 'admin', ['ADMIN']),
    ).rejects.toThrow('An organization with this name already exists');

    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('adds an organization manager while updating organization fields', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'manager-2' });
    prisma.userRole.findFirst.mockResolvedValue(null);
    prisma.organization.findUnique.mockResolvedValue({ id: 'org-1' });

    await service.update(
      'org-1',
      {
        name: 'Updated',
        license_plan: 'enterprise',
        manager_user_id: 'manager-2',
      },
      'admin',
      ['ADMIN'],
    );

    expect(roleDelegationService.assertTargetCanBeManaged).toHaveBeenCalledWith(
      'admin',
      ['ADMIN'],
      'manager-2',
    );
    expect(prisma.userRole.findMany).toHaveBeenCalledWith({
      where: {
        role: 'ORGANIZATION_MANAGER',
        organizationId: 'org-1',
      },
    });
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: {
        userId: 'manager-2',
        role: 'ORGANIZATION_MANAGER',
        organizationId: 'org-1',
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'ROLE_CHANGE',
        actorId: 'admin',
        metadata: {
          operation: 'assign',
          targetUserId: 'manager-2',
          role: 'ORGANIZATION_MANAGER',
          organizationId: 'org-1',
        },
      },
    });
  });

  it('deletes an organization', async () => {
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      _count: { departments: 0, userRoles: 0 },
    });
    prisma.organization.delete.mockResolvedValue({ id: 'org-1' });

    await service.remove('org-1');

    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      include: {
        _count: {
          select: {
            departments: true,
            userRoles: true,
          },
        },
      },
    });
    expect(prisma.organization.delete).toHaveBeenCalledWith({
      where: { id: 'org-1' },
    });
  });

  it('blocks deleting an organization with dependent data', async () => {
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      _count: { departments: 1, userRoles: 0 },
    });

    await expect(service.remove('org-1')).rejects.toThrow(ConflictException);
    expect(prisma.organization.delete).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when deleting a missing organization', async () => {
    prisma.organization.findUnique.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    expect(prisma.organization.delete).not.toHaveBeenCalled();
  });
});
