import { OrganizationsService } from './organizations.service';

describe('OrganizationsService', () => {
  const prisma = {
    organization: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };

  const organizationAccessService = {
    buildAccessibleOrganizationWhere: jest.fn(),
    assertCanViewOrganization: jest.fn(),
  };

  let service: OrganizationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    organizationAccessService.buildAccessibleOrganizationWhere.mockReturnValue({
      id: 'visible',
    });
    service = new OrganizationsService(
      prisma as any,
      organizationAccessService as any,
    );
  });

  it('creates an organization with license plan mapping', async () => {
    prisma.organization.create.mockResolvedValue({ id: 'org-1' });

    await service.create({ name: 'Engineering', license_plan: 'academic' });

    expect(prisma.organization.create).toHaveBeenCalledWith({
      data: {
        name: 'Engineering',
        licensePlan: 'academic',
      },
    });
  });

  it('lists organizations through scoped access filter', async () => {
    prisma.organization.findMany.mockResolvedValue([]);

    await service.findAll('actor', ['ORGANIZATION_MANAGER']);

    expect(prisma.organization.findMany).toHaveBeenCalledWith({
      where: { id: 'visible' },
      include: {
        _count: {
          select: {
            departments: true,
            userRoles: true,
          },
        },
      },
    });
  });

  it('updates organization fields with license plan mapping', async () => {
    prisma.organization.update.mockResolvedValue({ id: 'org-1' });

    await service.update('org-1', {
      name: 'Updated',
      license_plan: 'enterprise',
    });

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: {
        name: 'Updated',
        licensePlan: 'enterprise',
      },
    });
  });

  it('deletes an organization', async () => {
    prisma.organization.delete.mockResolvedValue({ id: 'org-1' });

    await service.remove('org-1');

    expect(prisma.organization.delete).toHaveBeenCalledWith({
      where: { id: 'org-1' },
    });
  });
});
