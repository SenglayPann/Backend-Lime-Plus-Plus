import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';
import { UsersService, GitHubProfile } from '../../users/users.service';

@Injectable()
export class GitHubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      clientID: configService.get<string>('GITHUB_CLIENT_ID')!,
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GITHUB_CALLBACK_URL')!,
      scope: ['user:email'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
  ): Promise<any> {
    const githubProfile: GitHubProfile = {
      id: profile.id,
      username: profile.username || '',
      displayName: profile.displayName,
      emails: profile.emails,
      photos: profile.photos,
    };

    const user = await this.usersService.findOrCreateFromGitHub(githubProfile);
    const roles = await this.usersService.getUserRoles(user.id);

    return {
      ...user,
      roles,
      accessToken,
    };
  }
}
