import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Role } from '../common/decorators/roles.decorator';
import { JwtPayload } from './strategies/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface TokenMetadata {
  userAgent?: string;
  ipAddress?: string;
}

export interface UserWithRoles {
  id: string;
  email: string | null;
  name: string | null;
  roles: Role[];
}

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
    private usersService: UsersService,
  ) {}

  async createHandoffCode(userId: string): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await this.prisma.authHandoffCode.create({
      data: {
        codeHash: this.hashToken(code),
        userId,
        expiresAt,
      },
    });

    return code;
  }

  async exchangeHandoffCode(
    code: string,
    metadata: TokenMetadata = {},
  ): Promise<TokenResponse | null> {
    const codeHash = this.hashToken(code);
    const handoffCode = await this.prisma.authHandoffCode.findUnique({
      where: { codeHash },
    });

    if (
      !handoffCode ||
      handoffCode.usedAt ||
      handoffCode.expiresAt <= new Date()
    ) {
      return null;
    }

    const claimed = await this.prisma.authHandoffCode.updateMany({
      where: {
        codeHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });

    if (claimed.count !== 1) {
      return null;
    }

    const user = await this.getCurrentUserForTokens(handoffCode.userId);
    if (!user) {
      return null;
    }

    return this.login(user, metadata);
  }

  async login(
    user: UserWithRoles,
    metadata: TokenMetadata = {},
  ): Promise<TokenResponse> {
    const payload = {
      sub: user.id,
      email: user.email || '',
      roles: user.roles,
    };

    const accessTokenExpiresIn = this.parseExpiryToSeconds(
      this.configService.get<string>('JWT_EXPIRES_IN') || '15m',
    );
    const refreshTokenExpiresIn = this.parseExpiryToSeconds(
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d',
    );

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: accessTokenExpiresIn,
    });

    const refreshTokenRecord = this.createRefreshTokenPayload(
      user.id,
      refreshTokenExpiresIn,
    );
    const refreshToken = this.jwtService.sign(refreshTokenRecord.payload, {
      expiresIn: refreshTokenExpiresIn,
    });

    await this.prisma.refreshToken.create({
      data: {
        id: refreshTokenRecord.id,
        tokenHash: this.hashToken(refreshToken),
        userId: user.id,
        expiresAt: refreshTokenRecord.expiresAt,
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTokenExpiresIn,
    };
  }

  async refreshToken(
    refreshToken: string,
    metadata: TokenMetadata = {},
  ): Promise<TokenResponse | null> {
    try {
      const payload = this.jwtService.verify<
        JwtPayload & { type?: string; jti?: string }
      >(refreshToken);

      if (payload.type !== 'refresh' || !payload.jti) {
        return null;
      }

      const existingToken = await this.prisma.refreshToken.findUnique({
        where: { id: payload.jti },
      });

      if (
        !existingToken ||
        existingToken.tokenHash !== this.hashToken(refreshToken)
      ) {
        return null;
      }

      if (existingToken.revokedAt) {
        if (existingToken.replacedByTokenId) {
          await this.revokeRefreshTokenChain(existingToken.replacedByTokenId);
        }
        return null;
      }

      if (existingToken.expiresAt <= new Date()) {
        return null;
      }

      const user = await this.getCurrentUserForTokens(payload.sub);
      if (!user) {
        await this.revokeRefreshToken(refreshToken);
        return null;
      }

      const newPayload = {
        sub: user.id,
        email: user.email || '',
        roles: user.roles,
      };

      const accessTokenExpiresIn = this.parseExpiryToSeconds(
        this.configService.get<string>('JWT_EXPIRES_IN') || '15m',
      );
      const refreshTokenExpiresIn = this.parseExpiryToSeconds(
        this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '7d',
      );

      const accessToken = this.jwtService.sign(newPayload, {
        expiresIn: accessTokenExpiresIn,
      });

      const newRefreshTokenRecord = this.createRefreshTokenPayload(
        user.id,
        refreshTokenExpiresIn,
      );
      const newRefreshToken = this.jwtService.sign(
        newRefreshTokenRecord.payload,
        { expiresIn: refreshTokenExpiresIn },
      );

      await this.prisma.$transaction([
        this.prisma.refreshToken.update({
          where: { id: existingToken.id },
          data: {
            revokedAt: new Date(),
            replacedByTokenId: newRefreshTokenRecord.id,
          },
        }),
        this.prisma.refreshToken.create({
          data: {
            id: newRefreshTokenRecord.id,
            tokenHash: this.hashToken(newRefreshToken),
            userId: user.id,
            expiresAt: newRefreshTokenRecord.expiresAt,
            userAgent: metadata.userAgent,
            ipAddress: metadata.ipAddress,
          },
        }),
      ]);

      return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: accessTokenExpiresIn,
      };
    } catch {
      return null;
    }
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    try {
      const payload = this.jwtService.verify<
        JwtPayload & { type?: string; jti?: string }
      >(refreshToken);

      if (payload.type !== 'refresh' || !payload.jti) {
        return;
      }

      await this.prisma.refreshToken.updateMany({
        where: {
          id: payload.jti,
          tokenHash: this.hashToken(refreshToken),
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    } catch {
      return;
    }
  }

  private async revokeRefreshTokenChain(startTokenId: string): Promise<void> {
    const tokenIds = new Set<string>();
    let currentTokenId: string | null = startTokenId;

    for (let depth = 0; currentTokenId && depth < 20; depth += 1) {
      const token: { id: string; replacedByTokenId: string | null } | null =
        await this.prisma.refreshToken.findUnique({
          where: { id: currentTokenId },
          select: { id: true, replacedByTokenId: true },
        });

      if (!token || tokenIds.has(token.id)) break;

      tokenIds.add(token.id);
      currentTokenId = token.replacedByTokenId;
    }

    if (tokenIds.size === 0) return;

    await this.prisma.refreshToken.updateMany({
      where: {
        id: { in: Array.from(tokenIds) },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  validateToken(token: string): JwtPayload | null {
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      return null;
    }
  }

  private parseExpiryToSeconds(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) return 900; // default 15 minutes

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      case 'd':
        return value * 60 * 60 * 24;
      default:
        return 900;
    }
  }

  private async getCurrentUserForTokens(
    userId: string,
  ): Promise<UserWithRoles | null> {
    const user = await this.usersService.findById(userId);
    if (!user) return null;

    const roles = await this.usersService.getUserRoles(user.id);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
    };
  }

  private createRefreshTokenPayload(
    userId: string,
    expiresInSeconds: number,
  ) {
    const id = randomUUID();

    return {
      id,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      payload: {
        sub: userId,
        type: 'refresh',
        jti: id,
      },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
