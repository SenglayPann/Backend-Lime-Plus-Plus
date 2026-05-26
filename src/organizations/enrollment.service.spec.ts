import { Test, TestingModule } from '@nestjs/testing';
import { EnrollmentService } from './enrollment.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import { AllowlistEntryType } from '../generated/prisma';
import { NotFoundException } from '@nestjs/common';

describe('EnrollmentService', () => {
  let service: EnrollmentService;
  let prisma: jest.Mocked<Partial<PrismaService>>;
  let orgAccess: jest.Mocked<Partial<OrganizationAccessService>>;
  let roleDelegation: jest.Mocked<Partial<RoleDelegationService>>;

  beforeEach(async () => {
    prisma = {
      organization: { findUnique: jest.fn() } as any,
      organizationAllowlistEntry: {
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
      } as any,
      userRole: {
        findFirst: jest.fn(),
        create: jest.fn(),
      } as any,
      user: {
        findMany: jest.fn(),
      } as any,
      $queryRaw: jest.fn(),
    };

    orgAccess = {
      assertCanManageOrganization: jest.fn().mockResolvedValue(undefined),
    };

    roleDelegation = {
      removeUserRole: jest.fn().mockResolvedValue({ id: 'removed-role' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrganizationAccessService, useValue: orgAccess },
        { provide: RoleDelegationService, useValue: roleDelegation },
      ],
    }).compile();

    service = module.get<EnrollmentService>(EnrollmentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAllowlistEntries', () => {
    it('returns allowlist entries', async () => {
      const mockEntries = [{ id: '1', type: 'EMAIL', value: 'test@acme.com' }];
      (prisma.organizationAllowlistEntry as any).findMany.mockResolvedValue(
        mockEntries,
      );

      const result = await service.getAllowlistEntries(
        'org-1',
        'actor-1',
        ['ORGANIZATION_MANAGER'],
      );

      expect(result).toEqual(mockEntries);
      expect(orgAccess.assertCanManageOrganization).toHaveBeenCalledWith(
        'actor-1',
        ['ORGANIZATION_MANAGER'],
        'org-1',
      );
    });
  });

  describe('addAllowlistEntries', () => {
    it('adds valid entries and eagerly enrolls users', async () => {
      (prisma.organization as any).findUnique.mockResolvedValue({ id: 'org-1' });
      (prisma.organizationAllowlistEntry as any).create.mockResolvedValue({ id: 'entry-1' });
      (prisma.user as any).findMany.mockResolvedValue([
        { id: 'user-1', email: 'test@acme.com', githubUsername: 'test' },
      ]);
      (prisma.userRole as any).findFirst.mockResolvedValue(null);
      (prisma.userRole as any).create.mockResolvedValue({ id: 'role-1' });

      const result = await service.addAllowlistEntries(
        'org-1',
        [{ type: 'EMAIL', value: 'test@acme.com' }],
        'actor-1',
        ['ORGANIZATION_MANAGER'],
      );

      expect(result).toEqual({
        created: 1,
        enrolled: 1,
        skipped: 0,
        skippedEntries: [],
      });
      expect(prisma.userRole!.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          role: 'ORGANIZATION_MEMBER',
          organizationId: 'org-1',
        },
      });
    });

    it('throws NotFoundException if organization does not exist', async () => {
      (prisma.organization as any).findUnique.mockResolvedValue(null);

      await expect(
        service.addAllowlistEntries(
          'org-2',
          [{ type: 'EMAIL', value: 'test@acme.com' }],
          'actor-1',
          ['ORGANIZATION_MANAGER'],
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeAllowlistEntry', () => {
    it('deletes entry without touching membership when revokeMembership is false', async () => {
      (prisma.organizationAllowlistEntry as any).findFirst.mockResolvedValue({
        id: 'entry-1',
        organizationId: 'org-1',
        claimedByUserId: 'user-1',
      });
      (prisma.organizationAllowlistEntry as any).delete.mockResolvedValue({});

      const result = await service.removeAllowlistEntry(
        'org-1',
        'entry-1',
        'actor-1',
        ['ORGANIZATION_MANAGER'],
        false,
      );

      expect(result).toEqual({ deleted: true, membershipRevoked: false });
      expect(roleDelegation.removeUserRole).not.toHaveBeenCalled();
      expect(prisma.organizationAllowlistEntry!.delete).toHaveBeenCalledWith({
        where: { id: 'entry-1' },
      });
    });

    it('revokes ORGANIZATION_MEMBER role when revokeMembership is true and entry is claimed', async () => {
      (prisma.organizationAllowlistEntry as any).findFirst.mockResolvedValue({
        id: 'entry-1',
        organizationId: 'org-1',
        claimedByUserId: 'user-1',
      });
      (prisma.userRole as any).findFirst.mockResolvedValue({ id: 'role-1' });
      (prisma.organizationAllowlistEntry as any).delete.mockResolvedValue({});

      const result = await service.removeAllowlistEntry(
        'org-1',
        'entry-1',
        'actor-1',
        ['ORGANIZATION_MANAGER'],
        true,
      );

      expect(result).toEqual({ deleted: true, membershipRevoked: true });
      expect(prisma.userRole!.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          organizationId: 'org-1',
          role: 'ORGANIZATION_MEMBER',
        },
        select: { id: true },
      });
      expect(roleDelegation.removeUserRole).toHaveBeenCalledWith(
        'actor-1',
        ['ORGANIZATION_MANAGER'],
        'role-1',
      );
    });

    it('does not call removeUserRole when entry is unclaimed even with revokeMembership=true', async () => {
      (prisma.organizationAllowlistEntry as any).findFirst.mockResolvedValue({
        id: 'entry-1',
        organizationId: 'org-1',
        claimedByUserId: null,
      });
      (prisma.organizationAllowlistEntry as any).delete.mockResolvedValue({});

      const result = await service.removeAllowlistEntry(
        'org-1',
        'entry-1',
        'actor-1',
        ['ORGANIZATION_MANAGER'],
        true,
      );

      expect(result).toEqual({ deleted: true, membershipRevoked: false });
      expect(roleDelegation.removeUserRole).not.toHaveBeenCalled();
    });

    it('skips role revocation when the user has no ORGANIZATION_MEMBER role for this org', async () => {
      (prisma.organizationAllowlistEntry as any).findFirst.mockResolvedValue({
        id: 'entry-1',
        organizationId: 'org-1',
        claimedByUserId: 'user-1',
      });
      (prisma.userRole as any).findFirst.mockResolvedValue(null);
      (prisma.organizationAllowlistEntry as any).delete.mockResolvedValue({});

      const result = await service.removeAllowlistEntry(
        'org-1',
        'entry-1',
        'actor-1',
        ['ORGANIZATION_MANAGER'],
        true,
      );

      expect(result).toEqual({ deleted: true, membershipRevoked: false });
      expect(roleDelegation.removeUserRole).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when entry does not exist', async () => {
      (prisma.organizationAllowlistEntry as any).findFirst.mockResolvedValue(null);

      await expect(
        service.removeAllowlistEntry(
          'org-1',
          'missing',
          'actor-1',
          ['ORGANIZATION_MANAGER'],
          true,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(roleDelegation.removeUserRole).not.toHaveBeenCalled();
    });
  });

  describe('autoEnrollIfAllowlisted', () => {
    it('does nothing if user has no email or username', async () => {
      await service.autoEnrollIfAllowlisted({ id: 'user-1', email: null, githubUsername: null });
      expect(prisma.organizationAllowlistEntry!.findMany).not.toHaveBeenCalled();
    });

    it('enrolls user into matching organizations', async () => {
      (prisma.organizationAllowlistEntry as any).findMany.mockResolvedValue([
        { id: 'entry-1', organizationId: 'org-1', type: 'DOMAIN', value: 'acme.com' },
      ]);
      (prisma.userRole as any).findFirst.mockResolvedValue(null); // Not already a member
      (prisma.userRole as any).create.mockResolvedValue({ id: 'role-1' });

      await service.autoEnrollIfAllowlisted({
        id: 'user-1',
        email: 'john@acme.com',
        githubUsername: 'johnacme',
      });

      expect(prisma.userRole!.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          role: 'ORGANIZATION_MEMBER',
          organizationId: 'org-1',
        },
      });
    });
  });
});
