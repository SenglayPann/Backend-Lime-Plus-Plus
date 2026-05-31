/**
 * Backfill: ensure every user who already has a scoped role also has an
 * ORGANIZATION_MEMBER UserRole on the role's organization. Idempotent.
 *
 * This catches users assigned before Idea 2 (auto-grant ORGANIZATION_MEMBER
 * on scoped role assignment) landed.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/backfill-org-membership.ts
 *   npx ts-node --project tsconfig.json scripts/backfill-org-membership.ts --apply
 *
 * Default is dry-run: prints the user/org pairs that WOULD be created.
 * Pass --apply to actually insert the rows + audit entries.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

interface GrantTarget {
  userId: string;
  organizationId: string;
  reasons: string[];
}

async function main() {
  const apply = process.argv.includes('--apply');

  // 1. Gather every (user, org) pair implied by existing roles.
  //    - UserRole rows with organizationId set
  //    - UserRole rows with departmentId set (climb to org)
  //    - ProjectMember rows (climb project → department → org)
  const userRoles = await prisma.userRole.findMany({
    select: {
      userId: true,
      role: true,
      organizationId: true,
      departmentId: true,
      department: { select: { organizationId: true } },
    },
  });

  const projectMembers = await prisma.projectMember.findMany({
    select: {
      userId: true,
      role: true,
      project: {
        select: { department: { select: { organizationId: true } } },
      },
    },
  });

  const pairs = new Map<string, GrantTarget>();

  const addPair = (userId: string, orgId: string | null, reason: string) => {
    if (!orgId) return;
    const key = `${userId}|${orgId}`;
    const existing = pairs.get(key);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      pairs.set(key, { userId, organizationId: orgId, reasons: [reason] });
    }
  };

  for (const r of userRoles) {
    const orgId = r.organizationId ?? r.department?.organizationId ?? null;
    addPair(r.userId, orgId, `${r.role}${r.departmentId ? ' (via dept)' : ''}`);
  }
  for (const pm of projectMembers) {
    addPair(
      pm.userId,
      pm.project.department.organizationId,
      `${pm.role} (via project)`,
    );
  }

  // 2. Filter out pairs that already have an ORGANIZATION_MEMBER row.
  const existingMemberships = await prisma.userRole.findMany({
    where: { role: 'ORGANIZATION_MEMBER' },
    select: { userId: true, organizationId: true },
  });
  const haveMembership = new Set(
    existingMemberships.map((m) => `${m.userId}|${m.organizationId}`),
  );

  const missing = [...pairs.values()].filter(
    (p) => !haveMembership.has(`${p.userId}|${p.organizationId}`),
  );

  if (missing.length === 0) {
    console.log('All implied org memberships are already in place. Nothing to backfill.');
    return;
  }

  // 3. Resolve names for legible output.
  const userIds = [...new Set(missing.map((m) => m.userId))];
  const orgIds = [...new Set(missing.map((m) => m.organizationId))];
  const [users, orgs] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, githubUsername: true },
    }),
    prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, name: true },
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  console.log(`Found ${missing.length} missing org membership(s):\n`);
  for (const m of missing) {
    const u = userById.get(m.userId);
    const o = orgById.get(m.organizationId);
    const userLabel = u
      ? `${u.name || u.githubUsername || u.id} (${u.id.slice(0, 8)})`
      : m.userId;
    const orgLabel = o ? `${o.name} (${o.id.slice(0, 8)})` : m.organizationId;
    console.log(`  - ${userLabel} → ${orgLabel}`);
    console.log(`      because: ${m.reasons.join(', ')}`);
  }

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to insert.');
    return;
  }

  // 4. Apply — create UserRole + audit row, one transaction per pair so a
  //    single failure doesn't abort the whole batch.
  const systemActor = await prisma.user.findFirst({
    where: { userRoles: { some: { role: 'ADMIN' } } },
    select: { id: true },
  });
  if (!systemActor) {
    console.error('No ADMIN user found to attribute audit rows to. Aborting.');
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;
  for (const m of missing) {
    try {
      await prisma.$transaction(async (tx) => {
        // Re-check under transaction to be safe across concurrent runs.
        const already = await tx.userRole.findFirst({
          where: {
            userId: m.userId,
            organizationId: m.organizationId,
            role: 'ORGANIZATION_MEMBER',
          },
          select: { id: true },
        });
        if (already) {
          skipped += 1;
          return;
        }
        await tx.userRole.create({
          data: {
            userId: m.userId,
            role: 'ORGANIZATION_MEMBER',
            organizationId: m.organizationId,
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'ROLE_CHANGE',
            actorId: systemActor.id,
            metadata: {
              operation: 'auto_grant_member',
              targetUserId: m.userId,
              role: 'ORGANIZATION_MEMBER',
              organizationId: m.organizationId,
              reason: 'Backfill: implied by existing scoped role(s)',
              implyingRoles: m.reasons,
            },
          },
        });
        created += 1;
      });
    } catch (err) {
      console.error(
        `  ! Failed to backfill ${m.userId} → ${m.organizationId}:`,
        err,
      );
    }
  }
  console.log(`\nCreated ${created} membership(s), skipped ${skipped} that already existed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
