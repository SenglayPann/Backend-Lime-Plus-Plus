import { DepartmentsService } from './departments.service';

describe('DepartmentsService', () => {
  const prisma = {
    department: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  const departmentAccessService = {
    assertCanCreateDepartment: jest.fn(),
    buildAccessibleDepartmentWhere: jest.fn(),
    assertCanViewDepartment: jest.fn(),
    assertCanManageDepartment: jest.fn(),
  };

  let service: DepartmentsService;

  beforeEach(() => {
    jest.clearAllMocks();
    departmentAccessService.buildAccessibleDepartmentWhere.mockReturnValue({
      id: 'visible',
    });
    service = new DepartmentsService(
      prisma as any,
      departmentAccessService as any,
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

  it('checks target organization permission when moving a department', async () => {
    prisma.department.update.mockResolvedValue({ id: 'dept-1' });

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
});
