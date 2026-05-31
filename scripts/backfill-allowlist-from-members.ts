/**
 * Backfill: for every user who currently has any scoped role in an
 * organization, ensure a matching APPROVED GITHUB_USERNAME allowlist
 * entry exists for that org. Idempotent.
 *
 * Why: the allowlist coupling (Idea 1) was added after roles had
 * already been assigned. Existing members therefore have ORG_MEMBER
 * UserRole rows but no allowlist entry, leaving the modal misleadingly
 * empty. This catches up the missing rows.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/backfill-allowlist-from-members.ts
 *   npx ts-node --project tsconfig.json scripts/backfill-allowlist-from-members.ts --apply
 *
 * Dry-run by default. Pass --apply to actually upsert.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

interface Plan {
  userId: string;
  githubUsername: string;
  organizationId: string;
  organizationName: string;
  reasons: string[];
}

async function main() {
  const apply = process.argv.includes('--apply');

  // Walk every (user, org) pair that has at least one scoped role.
  const userRoles = await prisma.userRole.findMany({
    select: {
      userId: true,
      role: true,
      organizationId: true,
      department: { select: { organizationId: true } },
      user: { select: { githubUsername: true } },
    },
  });
  const projectMembers = await prisma.projectMember.findMany({
    select: {
      userId: true,
      role: true,
      project: {
        select: { department: { select: { organizationId: true } } },
      },
      user: { select: { githubUsername: true } },
    },
  });

  const pairKey = (userId: string, orgId: string) => `${userId}|${orgId}`;
  const plans = new Map<string, Plan>();

  const addPair = (
    userId: string,
    orgId: string | null,
    githubUsername: string | null,
    reason: string,
  ) => {
    if (!orgId || !githubUsername) return;
    const key = pairKey(userId, orgId);
    const existing = plans.get(key);
    if (existing) {
      existing.reasons.push(reason);
      return;
    }
    plans.set(key, {
      userId,
      githubUsername,
      organizationId: orgId,
      organizationName: '',
      reasons: [reason],
    });
  };

  for (const r of userRoles) {
    const orgId = r.organizationId ?? r.department?.organizationId ?? null;
    addPair(
      r.userId,
      orgId,
      r.user.githubUsername,
      `${r.role}${r.department ? ' (via dept)' : ''}`,
    );
  }
  for (const pm of projectMembers) {
    addPair(
      pm.userId,
      pm.project.department.organizationId,
      pm.user.githubUsername,
      `${pm.role} (via project)`,
    );
  }

  // Resolve org names for the report.
  const orgIds = [...new Set([...plans.values()].map((p) => p.organizationId))];
  const orgs = await prisma.organization.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, name: true },
  });
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  for (const p of plans.values()) {
    p.organizationName = orgName.get(p.organizationId) ?? p.organizationId;
  }

  // Filter out pairs where an entry already exists at any status.
  // (We don't promote PENDING/REJECTED — the coupling code handles
  // promotion semantics correctly, but this script is purely a backfill
  // for missing rows.)
  const existing = await prisma.organizationAllowlistEntry.findMany({
    where: {
      type: 'GITHUB_USERNAME',
      organizationId: { in: orgIds },
    },
    select: { organizationId: true, value: true },
  });
  const haveEntry = new Set(
    existing.map(
      (e) => `${e.organizationId}|${e.value.toLowerCase()}`,
    ),
  );

  const missing = [...plans.values()].filter(
    (p) =>
      !haveEntry.has(
        `${p.organizationId}|${p.githubUsername.toLowerCase()}`,
      ),
  );

  if (missing.length === 0) {
    console.log('All implied APPROVED allowlist entries are already in place.');
    return;
  }

  console.log(`Found ${missing.length} missing entries:\n`);
  for (const p of missing) {
    console.log(
      `  - @${p.githubUsername.padEnd(22)} → ${p.organizationName}`,
    );
    console.log(`      because: ${p.reasons.join(', ')}`);
  }

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to upsert APPROVED entries.');
    return;
  }

  // Need an actor for the "added_by" attribution. Use the first ADMIN
  // we can find; in the very unlikely case of a DB with zero admins we
  // attribute to the user being approved themselves.
  const admin = await prisma.userRole.findFirst({
    where: { role: 'ADMIN' },
    select: { userId: true },
  });

  let created = 0;
  for (const p of missing) {
    const attributedTo = admin?.userId ?? p.userId;
    try {
      await prisma.organizationAllowlistEntry.upsert({
        where: {
          organizationId_type_value: {
            organizationId: p.organizationId,
            type: 'GITHUB_USERNAME',
            value: p.githubUsername,
          },
        },
        update: {
          status: 'APPROVED',
          approvedByUserId: attributedTo,
          approvedAt: new Date(),
          claimedByUserId: p.userId,
          claimedAt: new Date(),
        },
        create: {
          organizationId: p.organizationId,
          type: 'GITHUB_USERNAME',
          value: p.githubUsername,
          addedById: attributedTo,
          status: 'APPROVED',
          autoCreated: false,
          approvedByUserId: attributedTo,
          approvedAt: new Date(),
          claimedByUserId: p.userId,
          claimedAt: new Date(),
        },
      });
      created += 1;
    } catch (err) {
      console.error(
        `  ! Failed to upsert ${p.githubUsername} → ${p.organizationName}:`,
        err,
      );
    }
  }

  console.log(`\nUpserted ${created} APPROVED allowlist entries.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
