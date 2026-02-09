import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Role } from '../common/decorators/roles.decorator';
import { JwtPayload } from './strategies/jwt.strategy';

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
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
  ) {}

  async login(user: UserWithRoles): Promise<TokenResponse> {
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

    const refreshToken = this.jwtService.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: refreshTokenExpiresIn },
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: accessTokenExpiresIn,
    };
  }

  async refreshToken(refreshToken: string): Promise<TokenResponse | null> {
    try {
      const payload = this.jwtService.verify(refreshToken);
      
      if (payload.type !== 'refresh') {
        return null;
      }

      const newPayload = {
        sub: payload.sub,
        email: payload.email || '',
        roles: payload.roles || [],
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

      const newRefreshToken = this.jwtService.sign(
        { sub: payload.sub, type: 'refresh' },
        { expiresIn: refreshTokenExpiresIn },
      );

      return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: accessTokenExpiresIn,
      };
    } catch {
      return null;
    }
  }

  validateToken(token: string): any {
    try {
      return this.jwtService.verify(token);
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
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 60 * 60;
      case 'd': return value * 60 * 60 * 24;
      default: return 900;
    }
  }
}
