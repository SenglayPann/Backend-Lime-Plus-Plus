import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Role } from '../generated/prisma';
import type { Role as AccessRole } from '../common/decorators/roles.decorator';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import { UserVisibilityService } from '../common/access/user-visibility.service';
import { ProjectAccessService } from '../common/access/project-access.service';

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
    private roleDelegationService: RoleDelegationService,
    private userVisibilityService: UserVisibilityService,
    private projectAccessService: ProjectAccessService,
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
    const [userRoles, projectRoles] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId },
        select: { role: true },
      }),
      this.prisma.projectMember.findMany({
        where: { userId },
        select: { role: true },
      }),
    ]);

    return Array.from(
      new Set([
        ...userRoles.map((userRole) => userRole.role),
        ...projectRoles.map((projectRole) => projectRole.role),
      ]),
    );
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
      where: {
        userId,
        ...this.buildVisibleUserRoleWhere(actorId, actorRoles),
      },
    });

    return {
      ...user,
      roles,
    };
  }

  async getUserProfileWithScopes(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        githubUsername: true,
        avatarUrl: true,
        userRoles: {
          include: {
            organization: true,
            department: true,
          },
        },
        projectMembers: {
          select: {
            projectId: true,
            role: true,
            project: {
              select: {
                id: true,
                name: true,
                departmentId: true,
                department: {
                  include: { organization: true },
                },
              },
            },
          },
        },
      },
    });

    if (!user) return null;

    const roles = await this.getUserRoles(user.id);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      githubUsername: user.githubUsername,
      avatarUrl: user.avatarUrl,
      roles,
      scopes: {
        organizations: user.userRoles
          .filter((role) => role.role === Role.ORGANIZATION_MANAGER)
          .map((role) => ({
            id: role.organizationId,
            name: role.organization?.name || 'Unknown organization',
            role: role.role,
          }))
          .filter((scope) => Boolean(scope.id)),
        departments: user.userRoles
          .filter((role) => role.role === Role.DEPARTMENT_MANAGER)
          .map((role) => ({
            id: role.departmentId,
            name: role.department?.name || 'Unknown department',
            role: role.role,
            organizationId: role.department?.organizationId || null,
          }))
          .filter((scope) => Boolean(scope.id)),
        projects: user.projectMembers.map((member) => ({
          id: member.projectId,
          name: member.project.name,
          role: member.role,
          departmentId: member.project.departmentId,
          departmentName: member.project.department.name,
          organizationId: member.project.department.organizationId,
          organizationName: member.project.department.organization.name,
        })),
      },
    };
  }

  async assignRole(
    userId: string,
    role: Role,
    actorId: string,
    actorRoles: AccessRole[],
    organizationId?: string,
    departmentId?: string,
  ) {
    return this.roleDelegationService.assignUserRole(
      actorId,
      actorRoles,
      userId,
      role,
      organizationId,
      departmentId,
    );
  }

  async removeRole(roleId: string, actorId: string, actorRoles: AccessRole[]) {
    return this.roleDelegationService.removeUserRole(
      actorId,
      actorRoles,
      roleId,
    );
  }

  async findAll(actorId: string, actorRoles: AccessRole[]) {
    const visibleUserRoleWhere = this.buildVisibleUserRoleWhere(
      actorId,
      actorRoles,
    );
    const visibleProjectMemberWhere = this.buildVisibleProjectMemberWhere(
      actorId,
      actorRoles,
    );

    return this.prisma.user.findMany({
      where: this.userVisibilityService.buildVisibleUserWhere(
        actorId,
        actorRoles,
      ),
      select: {
        id: true,
        githubUserId: true,
        githubUsername: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
        userRoles: {
          where: visibleUserRoleWhere,
          include: {
            organization: { select: { id: true, name: true } },
            department: {
              select: {
                id: true,
                name: true,
                organizationId: true,
                organization: { select: { id: true, name: true } },
              },
            },
          },
        },
        projectMembers: {
          where: visibleProjectMemberWhere,
          select: {
            id: true,
            role: true,
            project: {
              select: {
                id: true,
                name: true,
                departmentId: true,
                department: {
                  select: {
                    id: true,
                    name: true,
                    organizationId: true,
                    organization: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
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

    if (actorRoles.includes('ADMIN')) {
      return;
    }

    const visibleUser = await this.prisma.user.findFirst({
      where: {
        AND: [
          { id: targetUserId },
          this.userVisibilityService.buildVisibleUserWhere(actorId, actorRoles),
        ],
      },
      select: { id: true },
    });

    if (visibleUser) {
      return;
    }

    throw new ForbiddenException(
      'You do not have permission to view this user',
    );
  }

  private buildVisibleUserRoleWhere(
    actorId: string,
    actorRoles: AccessRole[],
  ): Prisma.UserRoleWhereInput {
    if (actorRoles.includes('ADMIN')) {
      return {};
    }

    const clauses: Prisma.UserRoleWhereInput[] = [];

    if (actorRoles.includes('ORGANIZATION_MANAGER')) {
      clauses.push(
        {
          organization: {
            userRoles: {
              some: {
                userId: actorId,
                role: Role.ORGANIZATION_MANAGER,
              },
            },
          },
        },
        {
          department: {
            organization: {
              userRoles: {
                some: {
                  userId: actorId,
                  role: Role.ORGANIZATION_MANAGER,
                },
              },
            },
          },
        },
      );
    }

    if (actorRoles.includes('DEPARTMENT_MANAGER')) {
      clauses.push({
        department: {
          userRoles: {
            some: {
              userId: actorId,
              role: Role.DEPARTMENT_MANAGER,
            },
          },
        },
      });
    }

    if (clauses.length === 0) {
      return { id: '__no_visible_user_roles__' };
    }

    return clauses.length === 1 ? clauses[0] : { OR: clauses };
  }

  private buildVisibleProjectMemberWhere(
    actorId: string,
    actorRoles: AccessRole[],
  ): Prisma.ProjectMemberWhereInput {
    if (actorRoles.includes('ADMIN')) {
      return {};
    }

    const projectWhere = this.projectAccessService.buildAccessibleProjectWhere(
      actorId,
      actorRoles,
    );

    return { project: projectWhere };
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
