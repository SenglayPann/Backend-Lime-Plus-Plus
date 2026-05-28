import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';

export interface JwtPayload {
  sub: string; // user ID
  email: string;
  roles: string[];
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      // The Authorization header is the preferred and primary source.
      // The `access_token` query-param fallback exists ONLY because the
      // browser EventSource API cannot set custom headers and we need
      // SSE on `/projects/:id/events`. Tokens-in-URLs is a known anti-
      // pattern: they leak into web-server access logs, browser history,
      // and the Referer header.
      //
      // Mitigations relied on here:
      //   - JWTs are short-lived (15 minutes).
      //   - Calls are same-origin in the deployed topology, so the
      //     Referer leakage surface is limited.
      //   - Tokens are scoped via the per-project SSE channel — even a
      //     leaked token only grants the scope it already grants from a
      //     header.
      //
      // Do NOT introduce new non-SSE endpoints that rely on the query
      // form. If you need to add another SSE endpoint, the cleaner path
      // is a one-shot ticket exchange (see the comment on the SSE route
      // in projects.controller.ts).
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('access_token'),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET')!,
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.usersService.findById(payload.sub);

    if (!user) {
      return null;
    }

    const roles = await this.usersService.getUserRoles(user.id);

    return {
      id: user.id,
      githubUserId: user.githubUserId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      roles,
    };
  }
}
