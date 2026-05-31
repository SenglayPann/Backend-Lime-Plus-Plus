import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AllowlistEntryType, AuditAction, Prisma, Role as PrismaRole } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationAccessService } from '../common/access/organization-access.service';
import { RoleDelegationService } from '../common/access/role-delegation.service';
import type { Role } from '../common/decorators/roles.decorator';

export type AllowlistStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED' | 'UNKNOWN';

@Injectable()
export class ContributorVerificationService {
  private readonly logger = new Logger(ContributorVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationAccess: OrganizationAccessService,
    private readonly roleDelegation: RoleDelegationService,
  ) {}

  /**
   * Status of a GitHub contributor against an org's allowlist.
   *   APPROVED – has scored credit on this org's projects
   *   PENDING  – has been seen contributing but waits for approval
   *   REJECTED – org manager explicitly denied
   *   UNKNOWN  – never seen by Lime++ on this org
   */
  async getContributorStatus(
    githubUsername: string,
    organizationId: string,
  ): Promise<AllowlistStatusValue> {
    if (!githubUsername || !organizationId) return 'UNKNOWN';
    const entry = await this.prisma.organizationAllowlistEntry.findFirst({
      where: {
        organizationId,
        type: AllowlistEntryType.GITHUB_USERNAME,
        value: { equals: githubUsername, mode: 'insensitive' },
      },
      select: { status: true },
    });
    return (entry?.status as AllowlistStatusValue) ?? 'UNKNOWN';
  }

  /**
   * Idempotently record that a contributor has shown up on an org. If
   * no entry exists for this (org, github username) pair, creates a
   * PENDING one tagged auto_created=true. If an entry already exists at
   * any status, leaves it alone — APPROVED stays approved, REJECTED
   * stays rejected, PENDING just sits in the queue.
   *
   * Returns the resulting status so callers can decide whether to
   * skip a scoring side-effect.
   */
  async ensurePendingEntry(args: {
    organizationId: string;
    githubUsername: string;
    addedByUserId: string;
    note?: string;
  }): Promise<AllowlistStatusValue> {
    if (!args.githubUsername || !args.organizationId) return 'UNKNOWN';

    const existing = await this.prisma.organizationAllowlistEntry.findFirst({
      where: {
        organizationId: args.organizationId,
        type: AllowlistEntryType.GITHUB_USERNAME,
        value: { equals: args.githubUsername, mode: 'insensitive' },
      },
      select: { id: true, status: true },
    });
    if (existing) return existing.status as AllowlistStatusValue;

    try {
      await this.prisma.organizationAllowlistEntry.create({
        data: {
          organizationId: args.organizationId,
          type: AllowlistEntryType.GITHUB_USERNAME,
          value: args.githubUsername,
          addedById: args.addedByUserId,
          status: 'PENDING',
          autoCreated: true,
        },
      });
      this.logger.log(
        `Auto-created PENDING allowlist entry for ${args.githubUsername} in org ${args.organizationId}${args.note ? `: ${args.note}` : ''}`,
      );
    } catch (err) {
      // Race condition: another concurrent request created the entry
      // between our findFirst and create. Re-read and return the status.
      const after = await this.prisma.organizationAllowlistEntry.findFirst({
        where: {
          organizationId: args.organizationId,
          type: AllowlistEntryType.GITHUB_USERNAME,
          value: { equals: args.githubUsername, mode: 'insensitive' },
        },
        select: { status: true },
      });
      if (after) return after.status as AllowlistStatusValue;
      throw err;
    }
    return 'PENDING';
  }

  /**
   * Mark a contributor as APPROVED. Idempotent: if no entry exists yet
   * (e.g. PM is assigning someone we've never seen contribute), creates
   * an APPROVED entry attributed to the assigning manager. This is the
   * "manual assignment == implicit approval" path.
   */
  async approveContributor(args: {
    organizationId: string;
    githubUsername: string;
    approvedByUserId: string;
    autoCreated?: boolean;
  }): Promise<void> {
    if (!args.githubUsername || !args.organizationId) return;

    await this.prisma.organizationAllowlistEntry.upsert({
      where: {
        organizationId_type_value: {
          organizationId: args.organizationId,
          type: AllowlistEntryType.GITHUB_USERNAME,
          value: args.githubUsername,
        },
      },
      update: {
        status: 'APPROVED',
        approvedByUserId: args.approvedByUserId,
        approvedAt: new Date(),
      },
      create: {
        organizationId: args.organizationId,
        type: AllowlistEntryType.GITHUB_USERNAME,
        value: args.githubUsername,
        addedById: args.approvedByUserId,
        status: 'APPROVED',
        autoCreated: args.autoCreated ?? false,
        approvedByUserId: args.approvedByUserId,
        approvedAt: new Date(),
      },
    });
  }

  /**
   * Reject an allowlist entry. Coupling rule: rejection cascades —
   * every UserRole (ORGANIZATION_MEMBER, DEPARTMENT_MANAGER,
   * PROJECT_MANAGER supervisor, etc.) scoped to this org and every
   * ProjectMember row on the org's projects get removed for the matched
   * user. Global ADMIN roles are untouched (they aren't org-scoped).
   *
   * If stripping would leave the org without a manager, the call fails
   * with 409 (matches the existing removal invariant).
   */
  async rejectContributor(
    organizationId: string,
    entryId: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<{ rolesStripped: number; projectsStripped: number }> {
    await this.organizationAccess.assertCanManageOrganization(
      actorId,
      actorRoles,
      organizationId,
    );

    const entry = await this.prisma.organizationAllowlistEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry || entry.organizationId !== organizationId) {
      throw new NotFoundException('Allowlist entry not found');
    }
    if (entry.status === 'APPROVED') {
      // Approved entries must be explicitly removed via the delete flow
      // (which already supports revokeMembership=true) — silently
      // demoting them through reject would hide the destructive intent.
      throw new ForbiddenException(
        'Cannot reject an already-approved entry. Remove it instead.',
      );
    }

    // Look up the user — present only for GITHUB_USERNAME entries that
    // have actually signed in. EMAIL/DOMAIN entries never map to a user.
    const user =
      entry.type === AllowlistEntryType.GITHUB_USERNAME
        ? await this.prisma.user.findFirst({
            where: {
              githubUsername: { equals: entry.value, mode: 'insensitive' },
            },
            select: { id: true, githubUsername: true },
          })
        : null;

    const strip = user
      ? await this.cascadeStripUserFromOrg(user.id, organizationId)
      : { rolesStripped: 0, projectsStripped: 0 };

    await this.prisma.$transaction([
      this.prisma.organizationAllowlistEntry.update({
        where: { id: entryId },
        data: { status: 'REJECTED' },
      }),
      this.prisma.auditLog.create({
        data: {
          action: AuditAction.ROLE_CHANGE,
          actorId,
          metadata: {
            operation: 'allowlist_reject',
            entryId,
            organizationId,
            value: entry.value,
            cascadedRoles: strip.rolesStripped,
            cascadedProjects: strip.projectsStripped,
          },
        },
      }),
    ]);

    return strip;
  }

  /**
   * Remove every org-scoped role + project membership the user has on
   * this org. Used by rejection and by the "remove ORG_MEMBER" auto-
   * reject path. Preserves the "org must keep at least one manager"
   * invariant — if stripping would leave the org with no
   * ORGANIZATION_MANAGER, throws 409.
   */
  async cascadeStripUserFromOrg(
    userId: string,
    organizationId: string,
  ): Promise<{ rolesStripped: number; projectsStripped: number }> {
    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId,
        OR: [
          { organizationId },
          { department: { organizationId } },
        ],
      },
      select: { id: true, role: true, organizationId: true },
    });

    // Invariant: never strip the last ORGANIZATION_MANAGER.
    const orgManagerBeingStripped = userRoles.find(
      (r) => r.role === PrismaRole.ORGANIZATION_MANAGER && r.organizationId,
    );
    if (orgManagerBeingStripped) {
      const remainingManagers = await this.prisma.userRole.count({
        where: {
          organizationId,
          role: PrismaRole.ORGANIZATION_MANAGER,
          userId: { not: userId },
        },
      });
      if (remainingManagers === 0) {
        throw new ConflictException(
          'Cannot strip the last organization manager. Promote someone else first.',
        );
      }
    }

    const projectMembers = await this.prisma.projectMember.findMany({
      where: {
        userId,
        project: { department: { organizationId } },
      },
      select: { id: true, projectId: true, role: true },
    });

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({
        where: { id: { in: userRoles.map((r) => r.id) } },
      }),
      this.prisma.projectMember.deleteMany({
        where: { id: { in: projectMembers.map((m) => m.id) } },
      }),
    ]);

    this.logger.log(
      `Cascade-stripped user ${userId} from org ${organizationId}: ${userRoles.length} role(s), ${projectMembers.length} project membership(s)`,
    );

    return {
      rolesStripped: userRoles.length,
      projectsStripped: projectMembers.length,
    };
  }

  /**
   * Flip the GITHUB_USERNAME allowlist entry for this user to REJECTED.
   * Called from the role-delegation flow when ORG_MEMBER is removed,
   * to keep the two states coupled. Idempotent; no-op when no entry
   * exists or it's already REJECTED.
   */
  async rejectByUser(
    userId: string,
    organizationId: string,
    actorId: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubUsername: true },
    });
    if (!user?.githubUsername) return;

    const entry = await this.prisma.organizationAllowlistEntry.findFirst({
      where: {
        organizationId,
        type: AllowlistEntryType.GITHUB_USERNAME,
        value: { equals: user.githubUsername, mode: 'insensitive' },
      },
      select: { id: true, status: true },
    });
    if (!entry || entry.status === 'REJECTED') return;

    await this.prisma.$transaction([
      this.prisma.organizationAllowlistEntry.update({
        where: { id: entry.id },
        data: {
          status: 'REJECTED',
          claimedByUserId: null,
          claimedAt: null,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          action: AuditAction.ROLE_CHANGE,
          actorId,
          metadata: {
            operation: 'allowlist_reject_via_membership_removal',
            entryId: entry.id,
            organizationId,
            githubUsername: user.githubUsername,
          },
        },
      }),
    ]);
  }

  /**
   * Org-manager endpoint: flips a PENDING entry to APPROVED and
   * backfills TASK_COMPLETED contribution events for any merged PRs by
   * this contributor that were held back. Idempotent on already-
   * approved entries (returns retrocredits=0).
   */
  async approveAndRetroCredit(
    organizationId: string,
    entryId: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<{ status: AllowlistStatusValue; retroCredits: number }> {
    await this.organizationAccess.assertCanManageOrganization(
      actorId,
      actorRoles,
      organizationId,
    );

    const entry = await this.prisma.organizationAllowlistEntry.findUnique({
      where: { id: entryId },
    });
    if (!entry || entry.organizationId !== organizationId) {
      throw new NotFoundException('Allowlist entry not found');
    }
    if (entry.type !== AllowlistEntryType.GITHUB_USERNAME) {
      // EMAIL/DOMAIN entries are an auto-enrollment hint, not a single
      // contributor. They have no merged PRs to retro-credit.
      await this.prisma.organizationAllowlistEntry.update({
        where: { id: entryId },
        data: {
          status: 'APPROVED',
          approvedByUserId: actorId,
          approvedAt: new Date(),
        },
      });
      return { status: 'APPROVED', retroCredits: 0 };
    }

    await this.approveContributor({
      organizationId,
      githubUsername: entry.value,
      approvedByUserId: actorId,
    });

    // Find the Lime++ user that matches this GitHub username so we can
    // walk their PR history. If the user has never signed in, there's
    // nothing to retro-credit.
    const user = await this.prisma.user.findFirst({
      where: { githubUsername: { equals: entry.value, mode: 'insensitive' } },
      select: { id: true, githubUserId: true },
    });

    let retroCredits = 0;
    if (user) {
      // Coupling: an APPROVED contributor must also be an ORGANIZATION_MEMBER
      // of this org. Idempotent — no-op if the role already exists.
      await this.roleDelegation.ensureOrganizationMembership(
        user.id,
        organizationId,
        actorId,
      );

      retroCredits = await this.retroCreditContributor({
        organizationId,
        githubUserId: user.githubUserId,
      });

      // Update the claimed_by_user_id link if it wasn't already set.
      await this.prisma.organizationAllowlistEntry.update({
        where: { id: entryId },
        data: {
          claimedByUserId: user.id,
          claimedAt: new Date(),
        },
      });
    }

    await this.prisma.auditLog.create({
      data: {
        action: AuditAction.ROLE_CHANGE,
        actorId,
        metadata: {
          operation: 'allowlist_approve',
          entryId,
          organizationId,
          value: entry.value,
          retroCredits,
        },
      },
    });

    return { status: 'APPROVED', retroCredits };
  }

  /**
   * Retroactively emit TASK_COMPLETED contribution events for any merged
   * PRs by this contributor that were held back while pending. Called
   * from the approve flow. Returns the number of new credit events.
   */
  async retroCreditContributor(args: {
    organizationId: string;
    githubUserId: string;
  }): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { githubUserId: args.githubUserId },
      select: { id: true },
    });
    if (!user) return 0;

    const mergedPrs = await this.prisma.pullRequest.findMany({
      where: {
        authorId: user.id,
        status: 'MERGED',
        taskId: { not: null },
        project: { department: { organizationId: args.organizationId } },
      },
      include: { task: true, project: true },
    });

    let created = 0;
    for (const pr of mergedPrs) {
      if (!pr.task) continue;
      if (pr.task.assigneeId !== pr.authorId) continue;

      // Skip if a contribution event already exists.
      const already = await this.prisma.contributionEvent.findUnique({
        where: {
          projectId_userId_type_referenceId: {
            projectId: pr.projectId,
            userId: pr.authorId,
            type: 'TASK_COMPLETED',
            referenceId: pr.task.id,
          },
        },
      });
      if (already) continue;

      // Skip if another merged PR for the same task is already credited
      // (multiple-PRs-per-task rule: only first counts).
      const otherCredit = await this.prisma.contributionEvent.findFirst({
        where: {
          projectId: pr.projectId,
          type: 'TASK_COMPLETED',
          referenceId: pr.task.id,
        },
      });
      if (otherCredit) continue;

      await this.prisma.contributionEvent.create({
        data: {
          projectId: pr.projectId,
          userId: pr.authorId,
          type: 'TASK_COMPLETED',
          referenceId: pr.task.id,
          score: 10,
          createdAt: pr.mergedAt ?? new Date(),
        } as Prisma.ContributionEventUncheckedCreateInput,
      });
      if (pr.task.status !== 'DONE') {
        await this.prisma.task.update({
          where: { id: pr.task.id },
          data: {
            status: 'DONE',
            completedAt: pr.mergedAt ?? new Date(),
          },
        });
      }
      created += 1;
    }
    return created;
  }
}
