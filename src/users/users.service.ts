import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../common/decorators/roles.decorator';

export interface GitHubProfile {
  id: string;
  username: string;
  displayName: string;
  emails?: Array<{ value: string }>;
  photos?: Array<{ value: string }>;
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByGitHubId(githubUserId: string) {
    return this.prisma.user.findUnique({
      where: { githubUserId },
    });
  }

  async findOrCreateFromGitHub(profile: GitHubProfile) {
    const existingUser = await this.findByGitHubId(profile.id);
    
    if (existingUser) {
      // Update user info from GitHub
      return this.prisma.user.update({
        where: { id: existingUser.id },
        data: {
          name: profile.displayName || profile.username,
          email: profile.emails?.[0]?.value,
          avatarUrl: profile.photos?.[0]?.value,
        },
      });
    }

    // Create new user
    return this.prisma.user.create({
      data: {
        githubUserId: profile.id,
        name: profile.displayName || profile.username,
        email: profile.emails?.[0]?.value,
        avatarUrl: profile.photos?.[0]?.value,
      },
    });
  }

  async getUserRoles(userId: string): Promise<Role[]> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
    });
    return userRoles.map((ur) => ur.role as Role);
  }

  async getUserWithRoles(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    
    if (!user) return null;
    
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
    });
    
    return {
      ...user,
      roles,
    };
  }
}
