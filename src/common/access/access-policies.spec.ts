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
});
