import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DepartmentAccessService } from './department-access.service';
import { OrganizationAccessService } from './organization-access.service';
import { ProjectAccessService } from './project-access.service';

describe('scope-aware access policies', () => {
  const prisma = {
    organization: { findFirst: jest.fn(), findMany: jest.fn() },
    department: { findFirst: jest.fn(), findMany: jest.fn() },
    project: { findFirst: jest.fn(), findMany: jest.fn() },
    userRole: { findFirst: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('OrganizationAccessService', () => {
    const service = new OrganizationAccessService(prisma as any);

    it('allows admin to manage any organization', async () => {
      await expect(
        service.assertCanManageOrganization('admin', ['ADMIN'], 'org-1'),
      ).resolves.toBeUndefined();
      expect(prisma.userRole.findFirst).not.toHaveBeenCalled();
    });

    it('allows organization managers only inside assigned organizations', async () => {
      prisma.userRole.findFirst.mockResolvedValueOnce({ id: 'role-1' });

      await expect(
        service.assertCanManageOrganization(
          'manager',
          ['ORGANIZATION_MANAGER'],
          'org-1',
        ),
      ).resolves.toBeUndefined();
      expect(prisma.userRole.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'manager',
          role: 'ORGANIZATION_MANAGER',
          organizationId: 'org-1',
        },
        select: { id: true },
      });
    });

    it('hides organizations outside the actor scope', async () => {
      prisma.organization.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.assertCanViewOrganization(
          'member',
          ['PROJECT_MEMBER'],
          'org-2',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('keeps admin organization access global when combined with scoped roles', () => {
      expect(
        service.buildAccessibleOrganizationWhere('admin', [
          'ADMIN',
          'ORGANIZATION_MANAGER',
        ]),
      ).toEqual({});
    });
  });

  describe('DepartmentAccessService', () => {
    const service = new DepartmentAccessService(prisma as any);

    it('allows organization managers to create departments in managed organizations', async () => {
      prisma.userRole.findFirst.mockResolvedValueOnce({ id: 'role-1' });

      await expect(
        service.assertCanCreateDepartment(
          'manager',
          ['ORGANIZATION_MANAGER'],
          'org-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('blocks department creation outside the organization manager scope', async () => {
      prisma.userRole.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.assertCanCreateDepartment(
          'manager',
          ['ORGANIZATION_MANAGER'],
          'org-2',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('builds scoped department filters for project members', () => {
      expect(
        service.buildAccessibleDepartmentWhere('member', ['PROJECT_MEMBER']),
      ).toEqual({
        projects: {
          some: {
            members: {
              some: { userId: 'member' },
            },
          },
        },
      });
    });

    it('keeps admin department access global when combined with scoped roles', () => {
      expect(
        service.buildAccessibleDepartmentWhere('admin', [
          'ADMIN',
          'DEPARTMENT_MANAGER',
        ]),
      ).toEqual({});
      expect(
        service.buildAccessibleDepartmentWhere(
          'admin',
          ['ADMIN', 'DEPARTMENT_MANAGER'],
          'org-1',
        ),
      ).toEqual({ organizationId: 'org-1' });
    });
  });

  describe('ProjectAccessService', () => {
    const service = new ProjectAccessService(prisma as any);

    it('does not treat organization managers as global project admins', () => {
      expect(
        service.buildAccessibleProjectWhere('manager', [
          'ORGANIZATION_MANAGER',
        ]),
      ).toEqual({
        department: {
          organization: {
            userRoles: {
              some: {
                userId: 'manager',
                role: 'ORGANIZATION_MANAGER',
              },
            },
          },
        },
      });
    });

    it('keeps admin project access global when combined with scoped roles', () => {
      expect(
        service.buildAccessibleProjectWhere('admin', [
          'ADMIN',
          'PROJECT_MEMBER',
        ]),
      ).toEqual({});
      expect(
        service.buildManageableProjectWhere('admin', [
          'ADMIN',
          'PROJECT_MANAGER',
        ]),
      ).toEqual({});
    });

    it('allows department managers to create projects only in managed departments', async () => {
      prisma.userRole.findFirst.mockResolvedValueOnce({ id: 'role-1' });

      await expect(
        service.assertCanCreateProjectInDepartment(
          'teacher',
          ['DEPARTMENT_MANAGER'],
          'dept-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('allows organization managers to create projects under managed organizations', async () => {
      prisma.department.findFirst.mockResolvedValueOnce({ id: 'dept-1' });

      await expect(
        service.assertCanCreateProjectInDepartment(
          'manager',
          ['ORGANIZATION_MANAGER'],
          'dept-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('blocks project managers from creating projects outside their scoped department', async () => {
      prisma.userRole.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.assertCanCreateProjectInDepartment(
          'teacher',
          ['PROJECT_MANAGER'],
          'dept-other',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows project managers to create projects inside their scoped department', async () => {
      prisma.userRole.findFirst.mockResolvedValueOnce({ id: 'role-pm-1' });

      await expect(
        service.assertCanCreateProjectInDepartment(
          'teacher',
          ['PROJECT_MANAGER'],
          'dept-1',
        ),
      ).resolves.toBeUndefined();

      expect(prisma.userRole.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'teacher',
          role: 'PROJECT_MANAGER',
          departmentId: 'dept-1',
        },
        select: { id: true },
      });
    });

    it('builds project management scope from assigned manager roles only', () => {
      expect(
        service.buildManageableProjectWhere('manager', [
          'ORGANIZATION_MANAGER',
          'PROJECT_MANAGER',
          'PROJECT_MEMBER',
        ]),
      ).toEqual({
        OR: [
          {
            department: {
              organization: {
                userRoles: {
                  some: {
                    userId: 'manager',
                    role: 'ORGANIZATION_MANAGER',
                  },
                },
              },
            },
          },
          {
            members: {
              some: {
                userId: 'manager',
                role: 'PROJECT_MANAGER',
              },
            },
          },
        ],
      });
    });
  });

  describe('DepartmentAccessService – PROJECT_LEAD visibility', () => {
    const service = new DepartmentAccessService(prisma as any);

    it('builds scoped department filters for project leads via project membership', () => {
      expect(
        service.buildAccessibleDepartmentWhere('lead', ['PROJECT_LEAD']),
      ).toEqual({
        projects: {
          some: {
            members: {
              some: { userId: 'lead' },
            },
          },
        },
      });
    });

    it('builds scoped department filters for combined project lead and member roles', () => {
      const result = service.buildAccessibleDepartmentWhere('lead', [
        'PROJECT_LEAD',
        'PROJECT_MEMBER',
      ]);
      // hasAnyRole fires once for the combined check, producing a single clause (not duplicated)
      expect(result).toEqual({
        projects: {
          some: {
            members: {
              some: { userId: 'lead' },
            },
          },
        },
      });
    });
  });

  describe('OrganizationAccessService – PROJECT_LEAD visibility', () => {
    const service = new OrganizationAccessService(prisma as any);

    it('builds scoped organization filters for project leads via project membership', () => {
      expect(
        service.buildAccessibleOrganizationWhere('lead', ['PROJECT_LEAD']),
      ).toEqual({
        departments: {
          some: {
            projects: {
              some: {
                members: {
                  some: { userId: 'lead' },
                },
              },
            },
          },
        },
      });
    });
  });
});
