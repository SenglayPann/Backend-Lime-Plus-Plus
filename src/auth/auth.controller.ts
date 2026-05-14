import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService, TokenResponse } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../common/guards';
import { CurrentUser } from '../common/decorators';
import { ConfigService } from '@nestjs/config';
import type { RequestWithUser } from '../common/types/request.interface';

interface RefreshTokenDto {
  refreshToken: string;
}

interface ExchangeCodeDto {
  code: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
    private usersService: UsersService,
  ) {}

  /**
   * Initiates GitHub OAuth flow
   */
  @Get('github')
  @UseGuards(AuthGuard('github'))
  githubLogin() {
    // Guard redirects to GitHub
  }

  /**
   * Handles GitHub OAuth callback
   */
  @Get('github/callback')
  @UseGuards(AuthGuard('github'))
  async githubCallback(@Req() req: RequestWithUser, @Res() res: Response) {
    const code = await this.authService.createHandoffCode(req.user.id);

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    res.redirect(`${frontendUrl}/auth/callback?code=${code}`);
  }

  /**
   * Exchange one-time OAuth handoff code for app tokens
   */
  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async exchange(
    @Body() body: ExchangeCodeDto,
    @Req() req: RequestWithUser,
  ): Promise<TokenResponse> {
    const tokens = await this.authService.exchangeHandoffCode(body.code, {
      userAgent: req.get('user-agent') || undefined,
      ipAddress: req.ip,
    });

    if (!tokens) {
      throw new UnauthorizedException('Invalid or expired auth code');
    }

    return tokens;
  }

  /**
   * Refresh access token using refresh token
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async refresh(
    @Body() body: RefreshTokenDto,
    @Req() req: RequestWithUser,
  ): Promise<TokenResponse> {
    const tokens = await this.authService.refreshToken(body.refreshToken, {
      userAgent: req.get('user-agent') || undefined,
      ipAddress: req.ip,
    });

    if (!tokens) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return tokens;
  }

  /**
   * Logout - revoke the active refresh token when supplied.
   * Access tokens remain short-lived; clients should discard them locally.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Body() body: Partial<RefreshTokenDto>): Promise<{ message: string }> {
    if (body.refreshToken) {
      await this.authService.revokeRefreshToken(body.refreshToken);
    }

    return { message: 'Logged out successfully' };
  }

  /**
   * Get current authenticated user
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getProfile(@CurrentUser() user: RequestWithUser['user']) {
    return this.usersService.getUserProfileWithScopes(user.id);
  }
}
