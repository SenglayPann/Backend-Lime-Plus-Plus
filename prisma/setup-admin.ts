import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const userId = process.argv[2] ?? process.env.ADMIN_USER_ID;

  if (!userId) {
    console.error('❌ Missing user id.');
    console.error('   Usage:  ts-node prisma/setup-admin.ts <user-id>');
    console.error('   Or set ADMIN_USER_ID in the environment.');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    console.error(`❌ No user found with id ${userId}.`);
    process.exit(1);
  }

  // Global ADMIN role has NULL organization_id and NULL department_id.
  // The partial unique index `user_roles_admin_unique` enforces one per user.
  const existing = await prisma.userRole.findFirst({
    where: {
      userId,
      role: 'ADMIN',
      organizationId: null,
      departmentId: null,
    },
  });

  const label = user.name ?? user.email ?? user.githubUsername ?? user.id;

  if (existing) {
    console.log(`✅ ${label} already has the ADMIN role.`);
    return;
  }

  await prisma.userRole.create({
    data: {
      userId,
      role: 'ADMIN',
    },
  });

  console.log(`✅ Granted ADMIN role to ${label}.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('❌ setup-admin failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
