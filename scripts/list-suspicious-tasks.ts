/**
 * Diagnostic: list all tasks so we can identify PR-mirrored phantoms.
 *
 * Usage: npx ts-node --project tsconfig.json scripts/list-suspicious-tasks.ts
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

async function main() {
  const tasks = await prisma.task.findMany({
    select: {
      id: true,
      externalTaskId: true,
      title: true,
      status: true,
      description: true,
      projectId: true,
      createdAt: true,
    },
    orderBy: { externalTaskId: 'asc' },
  });

  for (const t of tasks) {
    const desc = t.description ? '(has description)' : '(no description)';
    console.log(`${t.externalTaskId.padEnd(10)} ${t.status.padEnd(12)} "${t.title}" ${desc}  id=${t.id}`);
  }

  console.log(`\nTotal: ${tasks.length} task(s)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
