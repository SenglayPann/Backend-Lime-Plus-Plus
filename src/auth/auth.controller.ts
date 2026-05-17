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
  Query,
  Injectable,
  ExecutionContext,
  Logger,
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

@Injectable()
export class GitHubPopupGuard extends AuthGuard('github') {
  getAuthenticateOptions(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const mode = request.query.mode;

    const options: any = {
      scope: ['user:email', 'repo', 'read:project'],
    };

    if (mode === 'popup') {
      options.state = 'mode:popup';
      options.prompt = 'consent';
    }

    return options;
  }
}

/**
 * Custom guard to preserve the 'state' parameter before Passport consumes it
 */
@Injectable()
export class GitHubCallbackGuard extends AuthGuard('github') {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // Preserve state on the request object
    (request as any).oauthState = request.query.state;
    return (await super.canActivate(context)) as boolean;
  }
}

interface RefreshTokenDto {
  refreshToken: string;
}

interface ExchangeCodeDto {
  code: string;
}

interface SwitchAccountDto {
  targetUserId: string;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private configService: ConfigService,
    private usersService: UsersService,
  ) {}

  /**
   * Initiates GitHub OAuth flow
   */
  @Get('github')
  @UseGuards(GitHubPopupGuard)
  async githubLogin() {
    // Guard redirects to GitHub
  }

  /**
   * Handles GitHub OAuth callback
   */
  @Get('github/callback')
  @UseGuards(GitHubCallbackGuard)
  async githubCallback(@Req() req: RequestWithUser, @Res() res: Response) {
    const code = await this.authService.createHandoffCode(req.user.id);
    
    // Check preserved state
    const state = (req as any).oauthState || req.query.state as string;
    const isPopup = state && state.includes('mode:popup');

    this.logger.log(`GitHub callback processed. Preserved State: ${state}, isPopup: ${isPopup}`);

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    if (isPopup) {
      res.redirect(`${frontendUrl}/auth/callback?code=${code}&mode=popup`);
    } else {
      res.redirect(`${frontendUrl}/auth/callback?code=${code}`);
    }
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
      browserId: (req.headers['x-browser-id'] as string) || undefined,
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
      browserId: (req.headers['x-browser-id'] as string) || undefined,
    });

    if (!tokens) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return tokens;
  }

  /**
   * Logout
   */
  @Post('logout')
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

  /**
   * Get all accounts linked to this browser
   */
  @Get('accounts')
  async getAccounts(@Req() req: any) {
    const browserId = req.headers['x-browser-id'] as string;
    if (!browserId) return [];
    return this.authService.getLinkedAccounts(browserId);
  }

  /**
   * Securely switch to another linked account
   */
  @Post('switch')
  @HttpCode(HttpStatus.OK)
  async switch(
    @Req() req: any,
    @Body() body: SwitchAccountDto,
  ): Promise<TokenResponse> {
    const browserId = req.headers['x-browser-id'] as string;
    if (!browserId) {
      throw new UnauthorizedException('Missing browser identifier');
    }

    const tokens = await this.authService.switchAccount(
      browserId,
      body.targetUserId,
      {
        userAgent: req.get('user-agent') || undefined,
        ipAddress: req.ip,
        browserId,
      },
    );

    if (!tokens) {
      throw new UnauthorizedException('Account switch not authorized');
    }

    return tokens;
  }
}
