/**
 * One-shot helper for the migration consolidation. Rewrites the
 * _prisma_migrations bookkeeping table so it reflects the single
 * 20260601000000_init folder instead of the three folders that were
 * squashed.
 *
 * Why this is needed:
 *   Prisma records "applied migrations" by folder name. If you just
 *   delete the old folders and run `prisma migrate deploy`, Prisma
 *   complains that previously-applied migrations are missing on disk.
 *   This script clears the table and inserts a single row pointing at
 *   the new init, signalling "the database is already at this state".
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/reconcile-consolidated-migration.ts            # dry run
 *   npx ts-node --project tsconfig.json scripts/reconcile-consolidated-migration.ts --apply    # rewrite
 *
 * Safe to run multiple times. Only touches _prisma_migrations.
 */
import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';

const NEW_MIGRATION = '20260601000000_init';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

async function main() {
  const apply = process.argv.includes('--apply');

  const existing = await prisma.$queryRaw<
    Array<{ migration_name: string; finished_at: Date | null }>
  >`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at`;

  console.log(`_prisma_migrations currently has ${existing.length} row(s):`);
  for (const row of existing) {
    console.log(
      `  - ${row.migration_name}   ${row.finished_at ? 'applied' : 'pending'}`,
    );
  }

  if (existing.length === 1 && existing[0].migration_name === NEW_MIGRATION) {
    console.log('\nAlready reconciled. Nothing to do.');
    return;
  }

  const migrationSql = readFileSync(
    join(process.cwd(), 'prisma', 'migrations', NEW_MIGRATION, 'migration.sql'),
    'utf8',
  );
  const checksum = createHash('sha256').update(migrationSql).digest('hex');

  console.log(`\nWill rewrite to a single row:`);
  console.log(`  - ${NEW_MIGRATION}   applied (checksum ${checksum.slice(0, 12)}…)`);

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to rewrite.');
    return;
  }

  await prisma.$transaction([
    prisma.$executeRawUnsafe('DELETE FROM "_prisma_migrations"'),
    prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, $1, NOW(), $2, NULL, NULL, NOW(), 1)`,
      checksum,
      NEW_MIGRATION,
    ),
  ]);

  console.log('\nDone. `npx prisma migrate status` should now report up to date.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
