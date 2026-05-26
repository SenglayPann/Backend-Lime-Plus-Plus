import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AllowlistEntryType,
  AuditAction,
  Role as PrismaRole,
} from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import type { Role } from '../common/decorators/roles.decorator';

interface AllowlistEntryInput {
  type: 'EMAIL' | 'DOMAIN' | 'GITHUB_USERNAME';
  value: string;
}

interface MatchableUser {
  id: string;
  email: string | null;
  githubUsername: string | null;
}

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationAccessService: OrganizationAccessService,
    private readonly roleDelegationService: RoleDelegationService,
  ) {}

  /**
   * Retrieve all allowlist entries for an organization with claimed status.
   */
  async getAllowlistEntries(
    organizationId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.organizationAccessService.assertCanManageOrganization(
      actorId,
      actorRoles,
      organizationId,
    );

    return this.prisma.organizationAllowlistEntry.findMany({
      where: { organizationId },
      include: {
        addedBy: {
          select: { id: true, name: true, githubUsername: true, email: true },
        },
        claimedByUser: {
          select: {
            id: true,
            name: true,
            githubUsername: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Add entries to the allowlist and eagerly enroll existing users.
   */
  async addAllowlistEntries(
    organizationId: string,
    entries: AllowlistEntryInput[],
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.organizationAccessService.assertCanManageOrganization(
      actorId,
      actorRoles,
      organizationId,
    );

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const normalized = entries.map((entry) => ({
      type: entry.type as AllowlistEntryType,
      value: this.normalizeEntryValue(entry.type, entry.value),
    }));

    this.validateEntries(normalized);

    const created: any[] = [];
    const skipped: string[] = [];

    for (const entry of normalized) {
      try {
        const record = await this.prisma.organizationAllowlistEntry.create({
          data: {
            organizationId,
            type: entry.type,
            value: entry.value,
            addedById: actorId,
          },
        });
        created.push(record);
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          skipped.push(`${entry.type}:${entry.value}`);
          continue;
        }
        throw error;
      }
    }

    // Eager enrollment for newly added entries
    const enrolledCount = await this.eagerEnrollExistingUsers(
      organizationId,
      normalized,
    );

    return {
      created: created.length,
      skipped: skipped.length,
      skippedEntries: skipped,
      enrolled: enrolledCount,
    };
  }

  /**
   * Parse a CSV string and add entries to the allowlist.
   * Expects one entry per line, auto-detects type:
   * - Starts with '@' → DOMAIN
   * - Contains '@' → EMAIL
   * - Otherwise → GITHUB_USERNAME
   */
  async addAllowlistEntriesFromCsv(
    organizationId: string,
    csvContent: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    const lines = csvContent
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    if (lines.length === 0) {
      throw new BadRequestException('CSV file is empty or contains no valid entries');
    }

    if (lines.length > 500) {
      throw new BadRequestException('CSV file cannot contain more than 500 entries');
    }

    const entries: AllowlistEntryInput[] = lines.map((line) => {
      // Remove quotes and extra whitespace
      const value = line.replace(/^["']|["']$/g, '').trim();
      return {
        type: this.detectEntryType(value),
        value,
      };
    });

    return this.addAllowlistEntries(organizationId, entries, actorId, actorRoles);
  }

  /**
   * Remove an allowlist entry.
   * When `revokeMembership` is true and the entry was claimed by a user,
   * also revokes that user's ORGANIZATION_MEMBER role for this organization.
   */
  async removeAllowlistEntry(
    organizationId: string,
    entryId: string,
    actorId: string,
    actorRoles: Role[],
    revokeMembership = false,
  ) {
    await this.organizationAccessService.assertCanManageOrganization(
      actorId,
      actorRoles,
      organizationId,
    );

    const entry = await this.prisma.organizationAllowlistEntry.findFirst({
      where: { id: entryId, organizationId },
    });

    if (!entry) {
      throw new NotFoundException('Allowlist entry not found');
    }

    let membershipRevoked = false;

    if (revokeMembership && entry.claimedByUserId) {
      const memberRole = await this.prisma.userRole.findFirst({
        where: {
          userId: entry.claimedByUserId,
          organizationId,
          role: PrismaRole.ORGANIZATION_MEMBER,
        },
        select: { id: true },
      });

      if (memberRole) {
        await this.roleDelegationService.removeUserRole(
          actorId,
          actorRoles,
          memberRole.id,
        );
        membershipRevoked = true;
      }
    }

    await this.prisma.organizationAllowlistEntry.delete({
      where: { id: entryId },
    });

    return { deleted: true, membershipRevoked };
  }

  /**
   * Auto-enroll a user into all matching orgs on sign-in.
   * Called from the GitHub OAuth strategy after findOrCreateFromGitHub.
   */
  async autoEnrollIfAllowlisted(user: MatchableUser) {
    if (!user.email && !user.githubUsername) {
      return;
    }

    const matchClauses = this.buildUserMatchClauses(user);
    if (matchClauses.length === 0) return;

    const matchingEntries = await this.prisma.organizationAllowlistEntry.findMany({
      where: {
        claimedByUserId: null,
        OR: matchClauses,
      },
      select: {
        id: true,
        organizationId: true,
        type: true,
        value: true,
      },
    });

    if (matchingEntries.length === 0) return;

    // Group by organizationId to avoid duplicate role creation
    const orgIds = [...new Set(matchingEntries.map((e) => e.organizationId))];

    for (const orgId of orgIds) {
      await this.enrollUserInOrg(user.id, orgId, matchingEntries);
    }

    this.logger.log(
      `Auto-enrolled user ${user.id} into ${orgIds.length} organization(s)`,
    );
  }

  /**
   * Eagerly enroll existing users that match newly added allowlist entries.
   */
  private async eagerEnrollExistingUsers(
    organizationId: string,
    entries: Array<{ type: AllowlistEntryType; value: string }>,
  ): Promise<number> {
    let enrolledCount = 0;

    for (const entry of entries) {
      const matchingUsers = await this.findUsersMatchingEntry(entry);

      for (const user of matchingUsers) {
        const enrolled = await this.enrollUserInOrg(
          user.id,
          organizationId,
          [{ id: '', organizationId, type: entry.type, value: entry.value }],
        );
        if (enrolled) enrolledCount++;
      }
    }

    return enrolledCount;
  }

  /**
   * Enroll a single user into an organization (if not already a member).
   */
  private async enrollUserInOrg(
    userId: string,
    organizationId: string,
    matchingEntries: Array<{
      id: string;
      organizationId: string;
      type: AllowlistEntryType;
      value: string;
    }>,
  ): Promise<boolean> {
    // Check if user already has any role in this organization
    const existingRole = await this.prisma.userRole.findFirst({
      where: {
        userId,
        organizationId,
      },
      select: { id: true },
    });

    if (existingRole) {
      // User already has a role in this org — mark entries as claimed but don't create another role
      await this.markEntriesClaimed(userId, organizationId, matchingEntries);
      return false;
    }

    // Also check if user is already connected via department or project
    const existingConnection = await this.prisma.userRole.findFirst({
      where: {
        userId,
        OR: [
          {
            department: { organizationId },
          },
        ],
      },
      select: { id: true },
    });

    if (existingConnection) {
      await this.markEntriesClaimed(userId, organizationId, matchingEntries);
      return false;
    }

    // Create ORGANIZATION_MEMBER role
    try {
      await this.prisma.userRole.create({
        data: {
          userId,
          role: PrismaRole.ORGANIZATION_MEMBER,
          organizationId,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        // Role already exists (race condition)
        return false;
      }
      throw error;
    }

    // Mark allowlist entries as claimed
    await this.markEntriesClaimed(userId, organizationId, matchingEntries);

    this.logger.log(
      `Enrolled user ${userId} as ORGANIZATION_MEMBER in org ${organizationId}`,
    );

    return true;
  }

  private async markEntriesClaimed(
    userId: string,
    organizationId: string,
    entries: Array<{
      id: string;
      organizationId: string;
      type: AllowlistEntryType;
      value: string;
    }>,
  ) {
    const orgEntries = entries.filter((e) => e.organizationId === organizationId);

    for (const entry of orgEntries) {
      // For entries created during eager enrollment (id is empty),
      // look them up by org + type + value
      if (!entry.id) {
        await this.prisma.organizationAllowlistEntry.updateMany({
          where: {
            organizationId,
            type: entry.type,
            value: entry.value,
            claimedByUserId: null,
          },
          data: {
            claimedByUserId: userId,
            claimedAt: new Date(),
          },
        });
      } else {
        await this.prisma.organizationAllowlistEntry.updateMany({
          where: {
            id: entry.id,
            claimedByUserId: null,
          },
          data: {
            claimedByUserId: userId,
            claimedAt: new Date(),
          },
        });
      }
    }
  }

  /**
   * Find users matching a single allowlist entry.
   */
  private async findUsersMatchingEntry(
    entry: { type: AllowlistEntryType; value: string },
  ): Promise<MatchableUser[]> {
    switch (entry.type) {
      case AllowlistEntryType.EMAIL:
        return this.prisma.user.findMany({
          where: {
            email: { equals: entry.value, mode: 'insensitive' },
          },
          select: { id: true, email: true, githubUsername: true },
        });

      case AllowlistEntryType.DOMAIN: {
        const domainPattern = `%@${entry.value}`;
        return this.prisma.$queryRaw<MatchableUser[]>`
          SELECT id, email, github_username as "githubUsername"
          FROM users
          WHERE LOWER(email) LIKE LOWER(${domainPattern})
        `;
      }

      case AllowlistEntryType.GITHUB_USERNAME:
        return this.prisma.user.findMany({
          where: {
            githubUsername: { equals: entry.value, mode: 'insensitive' },
          },
          select: { id: true, email: true, githubUsername: true },
        });

      default:
        return [];
    }
  }

  /**
   * Build Prisma OR clauses to find allowlist entries matching a user.
   */
  private buildUserMatchClauses(user: MatchableUser) {
    const clauses: any[] = [];

    if (user.email) {
      const emailLower = user.email.toLowerCase();
      const domain = emailLower.split('@')[1];

      // Exact email match
      clauses.push({
        type: AllowlistEntryType.EMAIL,
        value: { equals: emailLower, mode: 'insensitive' },
      });

      // Domain match
      if (domain) {
        clauses.push({
          type: AllowlistEntryType.DOMAIN,
          value: { equals: domain, mode: 'insensitive' },
        });
      }
    }

    if (user.githubUsername) {
      clauses.push({
        type: AllowlistEntryType.GITHUB_USERNAME,
        value: { equals: user.githubUsername, mode: 'insensitive' },
      });
    }

    return clauses;
  }

  private normalizeEntryValue(type: string, value: string): string {
    const trimmed = value.trim().toLowerCase();

    if (type === 'DOMAIN') {
      // Remove leading @ if present
      return trimmed.replace(/^@/, '');
    }

    return trimmed;
  }

  private validateEntries(
    entries: Array<{ type: AllowlistEntryType; value: string }>,
  ) {
    for (const entry of entries) {
      if (!entry.value || entry.value.length === 0) {
        throw new BadRequestException('Entry value cannot be empty');
      }

      if (entry.type === AllowlistEntryType.EMAIL) {
        if (!entry.value.includes('@') || entry.value.startsWith('@')) {
          throw new BadRequestException(
            `Invalid email address: ${entry.value}`,
          );
        }
      }

      if (entry.type === AllowlistEntryType.DOMAIN) {
        if (entry.value.includes('@')) {
          throw new BadRequestException(
            `Domain should not include @: ${entry.value}. Use just the domain like "acme.com"`,
          );
        }
        if (!entry.value.includes('.')) {
          throw new BadRequestException(
            `Invalid domain: ${entry.value}`,
          );
        }
      }

      if (entry.type === AllowlistEntryType.GITHUB_USERNAME) {
        if (entry.value.includes('@') || entry.value.includes(' ')) {
          throw new BadRequestException(
            `Invalid GitHub username: ${entry.value}`,
          );
        }
      }
    }
  }

  private detectEntryType(
    value: string,
  ): 'EMAIL' | 'DOMAIN' | 'GITHUB_USERNAME' {
    if (value.startsWith('@') || (value.includes('.') && !value.includes('@'))) {
      // Check if it looks like a domain (no @ but has a dot, or starts with @)
      if (value.startsWith('@')) return 'DOMAIN';
    }
    if (value.includes('@')) return 'EMAIL';
    return 'GITHUB_USERNAME';
  }

  private isUniqueConstraintError(error: unknown) {
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
