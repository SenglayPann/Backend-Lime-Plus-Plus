import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

describe('UsersService', () => {
  let service: UsersService;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    userRole: { findMany: jest.fn(), create: jest.fn(), delete: jest.fn() },
    projectMember: { findMany: jest.fn(), findFirst: jest.fn() },
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('test-secret'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
  });

  describe('findOrCreateFromGitHub', () => {
    it('should create user if not exists', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'u1',
        githubUsername: 'test',
      });

      const profile = {
        id: '123',
        username: 'test',
        displayName: 'Test User',
        emails: [{ value: 'test@test.com' }],
        photos: [{ value: 'avatar.url' }],
      };

      const user = await service.findOrCreateFromGitHub(profile);

      expect(mockPrismaService.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          githubUserId: '123',
          githubUsername: 'test',
          email: 'test@test.com',
        }) as unknown,
      });
      expect(user.githubUsername).toBe('test');
    });

    it('should update user if exists', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'u1',
        githubUserId: '123',
      });
      mockPrismaService.user.update.mockResolvedValue({
        id: 'u1',
        githubUsername: 'newtest',
      });

      const profile = {
        id: '123',
        username: 'newtest',
        displayName: 'New Name',
      };

      await service.findOrCreateFromGitHub(profile);

      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: expect.objectContaining({
          githubUsername: 'newtest',
          name: 'New Name',
        }) as unknown,
      });
    });
  });

  describe('findById', () => {
    it('should return a user by id', async () => {
      const mockUser = { id: 'user-1' };
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.findById('user-1');

      expect(result).toEqual(mockUser);
      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
    });
  });

  describe('findByGitHubId', () => {
    it('should return a user by github ID', async () => {
      const mockUser = { id: 'user-1', githubUserId: 'git-123' };
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.findByGitHubId('git-123');

      expect(result).toEqual(mockUser);
      expect(mockPrismaService.user.findUnique).toHaveBeenCalledWith({
        where: { githubUserId: 'git-123' },
      });
    });
  });

  describe('getUserRoles', () => {
    it('should return an array of roles for a user', async () => {
      mockPrismaService.userRole.findMany.mockResolvedValue([
        { role: 'ADMIN' },
      ]);
      mockPrismaService.projectMember.findMany.mockResolvedValue([
        { role: 'PROJECT_MEMBER' },
      ]);

      const result = await service.getUserRoles('user-1');

      expect(result).toEqual(['ADMIN', 'PROJECT_MEMBER']);
      expect(mockPrismaService.userRole.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { role: true },
      });
      expect(mockPrismaService.projectMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { role: true },
      });
    });
  });

  describe('getUserWithRoles', () => {
    it('should return null if user not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      const result = await service.getUserWithRoles('user-unknown', 'admin', [
        'ADMIN',
      ]);

      expect(result).toBeNull();
    });

    it('should return user with roles', async () => {
      const mockUser = { id: 'user-1', name: 'Test' };
      const mockRoles = [{ id: 'role-1', role: 'ADMIN' }];

      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.userRole.findMany.mockResolvedValue(mockRoles);

      const result = await service.getUserWithRoles('user-1', 'admin', [
        'ADMIN',
      ]);

      expect(result).toEqual({ ...mockUser, roles: mockRoles });
    });
  });

  describe('assignRole', () => {
    it('should assign a role to a user', async () => {
      const newRole = { id: 'role-1', userId: 'user-1', role: 'ADMIN' };
      mockPrismaService.userRole.create.mockResolvedValue(newRole);

      const result = await service.assignRole(
        'user-1',
        'ADMIN',
        'org-1',
        'dept-1',
      );

      expect(result).toEqual(newRole);
      expect(mockPrismaService.userRole.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          role: 'ADMIN',
          organizationId: 'org-1',
          departmentId: 'dept-1',
        },
      });
    });
  });

  describe('removeRole', () => {
    it('should remove a role', async () => {
      const deletedRole = { id: 'role-1' };
      mockPrismaService.userRole.delete.mockResolvedValue(deletedRole);

      const result = await service.removeRole('role-1');

      expect(result).toEqual(deletedRole);
      expect(mockPrismaService.userRole.delete).toHaveBeenCalledWith({
        where: { id: 'role-1' },
      });
    });
  });

  describe('findAll', () => {
    it('should return all users with roles', async () => {
      const mockUsers = [{ id: 'user-1', userRoles: [] }];
      mockPrismaService.user.findMany.mockResolvedValue(mockUsers);

      const result = await service.findAll();

      expect(result).toEqual(mockUsers);
      expect(mockPrismaService.user.findMany).toHaveBeenCalledWith({
        select: {
          id: true,
          githubUserId: true,
          githubUsername: true,
          email: true,
          name: true,
          avatarUrl: true,
          createdAt: true,
          userRoles: true,
        },
      });
    });
  });
});
