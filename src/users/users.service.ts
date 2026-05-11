import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '../generated/prisma';
import type { Role as AccessRole } from '../common/decorators/roles.decorator';

export interface GitHubProfile {
  id: string;
  username: string;
  displayName: string;
  emails?: Array<{ value: string }>;
  photos?: Array<{ value: string }>;
}

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

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

  async findOrCreateFromGitHub(profile: GitHubProfile, accessToken?: string) {
    const existingUser = await this.findByGitHubId(profile.id);
    const tokenData = accessToken
      ? {
          githubAccessToken: this.encryptToken(accessToken),
          githubTokenUpdatedAt: new Date(),
        }
      : {};

    if (existingUser) {
      // Update user info from GitHub
      return this.prisma.user.update({
        where: { id: existingUser.id },
        data: {
          githubUsername: profile.username,
          name: profile.displayName || profile.username,
          email: profile.emails?.[0]?.value,
          avatarUrl: profile.photos?.[0]?.value,
          ...tokenData,
        },
      });
    }

    // Create new user
    return this.prisma.user.create({
      data: {
        githubUserId: profile.id,
        githubUsername: profile.username,
        name: profile.displayName || profile.username,
        email: profile.emails?.[0]?.value,
        avatarUrl: profile.photos?.[0]?.value,
        ...tokenData,
      },
    });
  }

  async getGitHubAccessToken(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubAccessToken: true },
    });

    if (!user?.githubAccessToken) return null;
    return this.decryptToken(user.githubAccessToken);
  }

  async getUserRoles(userId: string): Promise<Role[]> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
    });
    return userRoles.map((ur) => ur.role);
  }

  async getUserWithRoles(
    userId: string,
    actorId: string,
    actorRoles: AccessRole[],
  ) {
    await this.assertCanViewUser(userId, actorId, actorRoles);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        githubUserId: true,
        githubUsername: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
      },
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

  async assignRole(
    userId: string,
    role: string,
    organizationId?: string,
    departmentId?: string,
  ) {
    return this.prisma.userRole.create({
      data: {
        userId,
        role: role as Role,
        organizationId,
        departmentId,
      },
    });
  }

  async removeRole(roleId: string) {
    return this.prisma.userRole.delete({
      where: { id: roleId },
    });
  }

  async findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        githubUserId: true,
        githubUsername: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
        userRoles: true,
      },
    });
  }

  private async assertCanViewUser(
    targetUserId: string,
    actorId: string,
    actorRoles: AccessRole[],
  ) {
    if (targetUserId === actorId) {
      return;
    }

    if (
      actorRoles.includes('ADMIN') ||
      actorRoles.includes('ORGANIZATION_OWNER')
    ) {
      return;
    }

    if (actorRoles.includes('DEPARTMENT_MANAGER')) {
      const match = await this.prisma.user.findFirst({
        where: {
          id: targetUserId,
          OR: [
            {
              userRoles: {
                some: {
                  department: {
                    userRoles: {
                      some: {
                        userId: actorId,
                        role: Role.DEPARTMENT_MANAGER,
                      },
                    },
                  },
                },
              },
            },
            {
              projectMembers: {
                some: {
                  project: {
                    department: {
                      userRoles: {
                        some: {
                          userId: actorId,
                          role: Role.DEPARTMENT_MANAGER,
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        select: { id: true },
      });

      if (match) {
        return;
      }
    }

    if (actorRoles.includes('PROJECT_MANAGER')) {
      const sharedManagedProject = await this.prisma.projectMember.findFirst({
        where: {
          userId: targetUserId,
          project: {
            members: {
              some: {
                userId: actorId,
                role: Role.PROJECT_MANAGER,
              },
            },
          },
        },
        select: { id: true },
      });

      if (sharedManagedProject) {
        return;
      }
    }

    throw new ForbiddenException('You do not have permission to view this user');
  }

  private encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  }

  private decryptToken(encryptedToken: string): string | null {
    try {
      const [version, iv, tag, encrypted] = encryptedToken.split(':');
      if (version !== 'v1' || !iv || !tag || !encrypted) return null;

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getEncryptionKey(),
        Buffer.from(iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64'));

      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }

  private getEncryptionKey(): Buffer {
    const secret =
      this.configService.get<string>('GITHUB_TOKEN_ENCRYPTION_KEY') ||
      this.configService.get<string>('JWT_SECRET');

    if (!secret) {
      throw new Error(
        'GITHUB_TOKEN_ENCRYPTION_KEY or JWT_SECRET is required to encrypt GitHub tokens',
      );
    }

    return scryptSync(secret, 'lime-github-token', 32);
  }
}
