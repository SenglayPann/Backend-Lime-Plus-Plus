import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

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
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrismaService },
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
        }),
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
        }),
      });
    });
  });
});
