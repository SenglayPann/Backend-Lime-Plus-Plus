import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService, UserWithRoles } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: JwtService;
  let configService: ConfigService;
  let prismaService: typeof mockPrismaService;
  let usersService: typeof mockUsersService;

  const mockUser: UserWithRoles = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    roles: ['ADMIN'],
  };

  const mockPrismaService = {
    authHandoffCode: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
  };

  const mockUsersService = {
    findById: jest.fn(),
    getUserRoles: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn((payload: { type?: string; jti?: string }) =>
              payload.type === 'refresh'
                ? `mock-refresh-token-${payload.jti}`
                : 'mock-access-token',
            ),
            verify: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, string> = {
                JWT_EXPIRES_IN: '15m',
                JWT_REFRESH_EXPIRES_IN: '7d',
              };
              return config[key];
            }),
          },
        },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: UsersService, useValue: mockUsersService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get<JwtService>(JwtService);
    configService = module.get<ConfigService>(ConfigService);
    prismaService = module.get(PrismaService);
    usersService = module.get(UsersService);

    jest.clearAllMocks();
    mockPrismaService.$transaction.mockImplementation(
      async (operations: Array<Promise<unknown>>) => Promise.all(operations),
    );
    mockUsersService.findById.mockResolvedValue(mockUser);
    mockUsersService.getUserRoles.mockResolvedValue(mockUser.roles);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('login', () => {
    it('should return access token, refresh token, and expiresIn', async () => {
      const result = await service.login(mockUser);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('expiresIn');
      expect(result.expiresIn).toBe(900); // 15m = 900s
    });

    it('should sign JWT with correct payload', async () => {
      const signSpy = jest.spyOn(jwtService, 'sign');
      await service.login(mockUser);

      expect(signSpy).toHaveBeenCalledWith(
        { sub: 'user-123', email: 'test@example.com', roles: ['ADMIN'] },
        { expiresIn: 900 },
      );
    });

    it('should sign refresh token with sub and type', async () => {
      const signSpy = jest.spyOn(jwtService, 'sign');
      await service.login(mockUser);

      expect(signSpy).toHaveBeenCalledWith(
        { sub: 'user-123', type: 'refresh', jti: expect.any(String) },
        { expiresIn: 604800 }, // 7d
      );
    });

    it('should persist a hashed refresh token record', async () => {
      await service.login(mockUser, {
        userAgent: 'jest-agent',
        ipAddress: '127.0.0.1',
      });

      expect(prismaService.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: expect.any(String),
          tokenHash: expect.any(String),
          userId: 'user-123',
          expiresAt: expect.any(Date),
          userAgent: 'jest-agent',
          ipAddress: '127.0.0.1',
        }),
      });
      expect(
        prismaService.refreshToken.create.mock.calls[0][0].data.tokenHash,
      ).not.toContain('mock-refresh-token');
    });

    it('should handle null email by defaulting to empty string', async () => {
      const signSpy = jest.spyOn(jwtService, 'sign');
      const userNoEmail: UserWithRoles = { ...mockUser, email: null };
      await service.login(userNoEmail);

      expect(signSpy).toHaveBeenCalledWith(
        { sub: 'user-123', email: '', roles: ['ADMIN'] },
        { expiresIn: 900 },
      );
    });
  });

  describe('refreshToken', () => {
    it('should return new tokens when given a valid refresh token', async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: 'user-123',
        type: 'refresh',
        jti: 'refresh-id-1',
      });
      prismaService.refreshToken.findUnique.mockResolvedValue({
        id: 'refresh-id-1',
        userId: 'user-123',
        tokenHash:
          'ba518c093e1e0df01cfe01436563cd37f6a1f47697fcc620e818a2d062665083',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.refreshToken('valid-refresh-token');

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('expiresIn');
      expect(usersService.findById).toHaveBeenCalledWith('user-123');
      expect(usersService.getUserRoles).toHaveBeenCalledWith('user-123');
      expect(prismaService.$transaction).toHaveBeenCalled();
    });

    it('should return null when token type is not refresh', async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: 'user-123',
        type: 'access',
      });

      const result = await service.refreshToken('not-a-refresh-token');
      expect(result).toBeNull();
    });

    it('should return null when token is invalid/expired', async () => {
      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error('jwt expired');
      });

      const result = await service.refreshToken('expired-token');
      expect(result).toBeNull();
    });

    it('should return null when the persisted refresh token is revoked', async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: 'user-123',
        type: 'refresh',
        jti: 'refresh-id-1',
      });
      prismaService.refreshToken.findUnique.mockResolvedValue({
        id: 'refresh-id-1',
        userId: 'user-123',
        tokenHash:
          'ba518c093e1e0df01cfe01436563cd37f6a1f47697fcc620e818a2d062665083',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const result = await service.refreshToken('valid-refresh-token');
      expect(result).toBeNull();
    });
  });

  describe('exchangeHandoffCode', () => {
    it('should exchange an unused handoff code for tokens', async () => {
      prismaService.authHandoffCode.findUnique.mockResolvedValue({
        codeHash: expect.any(String),
        userId: 'user-123',
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
      });
      prismaService.authHandoffCode.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.exchangeHandoffCode('handoff-code');

      expect(result).not.toBeNull();
      expect(prismaService.authHandoffCode.updateMany).toHaveBeenCalledWith({
        where: {
          codeHash: expect.any(String),
          usedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
        data: { usedAt: expect.any(Date) },
      });
    });

    it('should reject expired or reused handoff codes', async () => {
      prismaService.authHandoffCode.findUnique.mockResolvedValue({
        codeHash: expect.any(String),
        userId: 'user-123',
        expiresAt: new Date(Date.now() - 60_000),
        usedAt: null,
      });

      await expect(service.exchangeHandoffCode('handoff-code')).resolves.toBeNull();
      expect(prismaService.authHandoffCode.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('validateToken', () => {
    it('should return decoded payload for a valid token', () => {
      const mockPayload = { sub: 'user-123', email: 'test@example.com' };
      (jwtService.verify as jest.Mock).mockReturnValue(mockPayload);

      const result = service.validateToken('valid-token');
      expect(result).toEqual(mockPayload);
    });

    it('should return null for an invalid token', () => {
      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error('invalid token');
      });

      const result = service.validateToken('invalid-token');
      expect(result).toBeNull();
    });
  });

  describe('parseExpiryToSeconds (via login)', () => {
    it('should parse seconds correctly', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'JWT_EXPIRES_IN') return '30s';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '60s';
      });

      const result = await service.login(mockUser);
      expect(result.expiresIn).toBe(30);
    });

    it('should parse minutes correctly', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'JWT_EXPIRES_IN') return '5m';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '60m';
      });

      const result = await service.login(mockUser);
      expect(result.expiresIn).toBe(300);
    });

    it('should parse hours correctly', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'JWT_EXPIRES_IN') return '2h';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '24h';
      });

      const result = await service.login(mockUser);
      expect(result.expiresIn).toBe(7200);
    });

    it('should parse days correctly', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'JWT_EXPIRES_IN') return '1d';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
      });

      const result = await service.login(mockUser);
      expect(result.expiresIn).toBe(86400);
    });

    it('should default to 900s for invalid format', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) => {
        if (key === 'JWT_EXPIRES_IN') return 'invalid';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return 'invalid';
      });

      const result = await service.login(mockUser);
      expect(result.expiresIn).toBe(900);
    });
  });
});
