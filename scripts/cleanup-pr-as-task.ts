/**
 * One-time cleanup for L2: removes Task rows that were created from
 * pull_request items mistakenly mirrored as tasks by the old TaskSyncHandler.
 *
 * Run with:
 *   npx ts-node --project tsconfig.json scripts/cleanup-pr-as-task.ts            # dry-run
 *   npx ts-node --project tsconfig.json scripts/cleanup-pr-as-task.ts --apply    # actually delete
 *
 * Detection: a Task with externalTaskId "TASK-N" is treated as a PR mirror when
 * a PullRequest with externalPrId "N" exists in the same project, because GitHub
 * issues and PRs share a single number sequence per repo.
 */
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

async function main() {
  const apply = process.argv.includes('--apply');

  const tasks = await prisma.task.findMany({
    select: { id: true, projectId: true, externalTaskId: true, title: true },
  });

  const candidates: { id: string; externalTaskId: string; title: string; projectId: string }[] = [];

  for (const task of tasks) {
    const match = /^TASK-(\d+)$/.exec(task.externalTaskId);
    if (!match) continue;
    const number = match[1];

    const pr = await prisma.pullRequest.findUnique({
      where: {
        projectId_externalPrId: {
          projectId: task.projectId,
          externalPrId: number,
        },
      },
      select: { id: true, taskId: true },
    });
    if (!pr) continue;
    // If this PR points to a DIFFERENT task, the Task row we're looking at is
    // definitely the PR mirror — the real task is elsewhere.
    if (pr.taskId && pr.taskId !== task.id) {
      candidates.push(task);
      continue;
    }
    // PR exists with no task link, and a Task exists with the PR's number.
    // The Task here is the mirrored PR (real tasks pointing at PRs would have
    // been linked via pr-lifecycle).
    if (!pr.taskId) {
      candidates.push(task);
    }
  }

  if (candidates.length === 0) {
    console.log('No PR-derived task rows found. Nothing to clean up.');
    return;
  }

  console.log(`Found ${candidates.length} PR-derived task row(s):`);
  for (const c of candidates) {
    console.log(`  - ${c.externalTaskId} (${c.id}) — "${c.title}"`);
  }

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to delete.');
    return;
  }

  // Detach any PRs that were linked to these phantom tasks, so the PR row
  // survives and can be re-linked to the real task once webhook flow recovers.
  for (const c of candidates) {
    await prisma.pullRequest.updateMany({
      where: { taskId: c.id },
      data: { taskId: null },
    });
  }

  const result = await prisma.task.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  });
  console.log(`\nDeleted ${result.count} task row(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
