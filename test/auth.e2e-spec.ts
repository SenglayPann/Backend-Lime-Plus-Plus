import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { TransformInterceptor } from '../src/common/interceptors';
import { HttpExceptionFilter } from '../src/common/filters';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth Endpoints (e2e)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let accessToken: string;
  let refreshToken: string;

  // Mock PrismaService to avoid needing a real database
  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userRole: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());

    await app.init();

    jwtService = moduleFixture.get<JwtService>(JwtService);

    // Generate test tokens for authenticated requests
    accessToken = jwtService.sign(
      { sub: 'test-user-1', email: 'test@example.com', roles: ['ADMIN'] },
      { expiresIn: 900 },
    );

    refreshToken = jwtService.sign(
      { sub: 'test-user-1', type: 'refresh' },
      { expiresIn: 604800 },
    );
  });

  // Default mock: JWT strategy calls findById for every authenticated request
  beforeEach(() => {
    mockPrismaService.user.findUnique.mockResolvedValue({
      id: 'test-user-1',
      email: 'test@example.com',
      name: 'Test User',
      avatarUrl: 'https://example.com/avatar.png',
      githubUserId: 'github-123',
      createdAt: new Date(),
    });
    mockPrismaService.userRole.findMany.mockResolvedValue([
      { role: 'ADMIN', userId: 'test-user-1' },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('should return new tokens when given a valid refresh token', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.OK)
        .expect((res) => {
          expect(res.body).toHaveProperty('data');
          expect(res.body.data).toHaveProperty('accessToken');
          expect(res.body.data).toHaveProperty('refreshToken');
          expect(res.body.data).toHaveProperty('expiresIn');
        });
    });

    it('should return 401 when given an invalid refresh token', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid-token' })
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('should return 401 when given an access token instead of refresh token', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: accessToken }) // access token, not refresh
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('should return 200 with message when authenticated', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK)
        .expect((res) => {
          expect(res.body.data).toHaveProperty('message', 'Logged out successfully');
        });
    });

    it('should return 401 when not authenticated', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .expect(HttpStatus.UNAUTHORIZED);
    });

    it('should return 401 with invalid token', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', 'Bearer invalid-token')
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('GET /api/v1/auth/me', () => {

    it('should return user profile when authenticated', () => {
      return request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(HttpStatus.OK)
        .expect((res) => {
          expect(res.body.data).toHaveProperty('id');
          expect(res.body.data).toHaveProperty('email');
          expect(res.body.data).toHaveProperty('name');
          expect(res.body.data).toHaveProperty('roles');
        });
    });

    it('should return 401 when not authenticated', () => {
      return request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .expect(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('Response format', () => {
    it('successful responses should follow { success: true, data: ... } format', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.OK)
        .expect((res) => {
          expect(res.body).toHaveProperty('success', true);
          expect(res.body).toHaveProperty('data');
        });
    });

    it('error responses should follow { success: false, error: { ... } } format', () => {
      return request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'bad-token' })
        .expect(HttpStatus.UNAUTHORIZED)
        .expect((res) => {
          expect(res.body).toHaveProperty('success', false);
          expect(res.body).toHaveProperty('error');
          expect(res.body.error).toHaveProperty('code');
          expect(res.body.error).toHaveProperty('message');
        });
    });
  });
});
