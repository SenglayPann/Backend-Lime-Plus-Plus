import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService, UserWithRoles } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: JwtService;
  let configService: ConfigService;

  const mockUser: UserWithRoles = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    roles: ['ADMIN'],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('mock-token'),
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
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get<JwtService>(JwtService);
    configService = module.get<ConfigService>(ConfigService);
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
      await service.login(mockUser);

      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-123', email: 'test@example.com', roles: ['ADMIN'] },
        { expiresIn: 900 },
      );
    });

    it('should sign refresh token with sub and type', async () => {
      await service.login(mockUser);

      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-123', type: 'refresh' },
        { expiresIn: 604800 }, // 7d
      );
    });

    it('should handle null email by defaulting to empty string', async () => {
      const userNoEmail: UserWithRoles = { ...mockUser, email: null };
      await service.login(userNoEmail);

      expect(jwtService.sign).toHaveBeenCalledWith(
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
        email: 'test@example.com',
        roles: ['ADMIN'],
      });

      const result = await service.refreshToken('valid-refresh-token');

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('expiresIn');
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
