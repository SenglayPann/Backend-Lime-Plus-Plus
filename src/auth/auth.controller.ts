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
import type { Response, Request } from 'express';
import { AuthService, TokenResponse } from './auth.service';
import { JwtAuthGuard } from '../common/guards';
import { CurrentUser } from '../common/decorators';
import { ConfigService } from '@nestjs/config';

interface RefreshTokenDto {
  refreshToken: string;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
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
  async githubCallback(@Req() req: any, @Res() res: any) {
    const tokens = await this.authService.login(req.user);
    
    // For development, redirect with tokens in query params
    // In production, you'd set secure HTTP-only cookies or redirect to frontend
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    
    res.redirect(
      `${frontendUrl}/auth/callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&expiresIn=${tokens.expiresIn}`,
    );
  }

  /**
   * Refresh access token using refresh token
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: RefreshTokenDto): Promise<TokenResponse> {
    const tokens = await this.authService.refreshToken(body.refreshToken);
    
    if (!tokens) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    
    return tokens;
  }

  /**
   * Logout - invalidate tokens
   * For stateless JWT, client simply discards tokens
   * Future: Add token to blocklist for true revocation
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  logout(): { message: string } {
    return { message: 'Logged out successfully' };
  }

  /**
   * Get current authenticated user
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getProfile(@CurrentUser() user: any) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      roles: user.roles,
    };
  }
}
