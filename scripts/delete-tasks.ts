/**
 * Delete specific tasks by externalTaskId (per-project).
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/delete-tasks.ts <projectId> <externalTaskId> [<externalTaskId>...]
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

async function main() {
  const [, , projectId, ...externalIds] = process.argv;
  if (!projectId || externalIds.length === 0) {
    console.error('Usage: delete-tasks.ts <projectId> <externalTaskId>...');
    process.exit(1);
  }

  for (const externalTaskId of externalIds) {
    const task = await prisma.task.findUnique({
      where: { projectId_externalTaskId: { projectId, externalTaskId } },
    });
    if (!task) {
      console.log(`  - ${externalTaskId}: not found, skipping`);
      continue;
    }
    // Detach any PRs linked to this task first
    await prisma.pullRequest.updateMany({
      where: { taskId: task.id },
      data: { taskId: null },
    });
    await prisma.task.delete({ where: { id: task.id } });
    console.log(`  - ${externalTaskId}: deleted (id=${task.id})`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
