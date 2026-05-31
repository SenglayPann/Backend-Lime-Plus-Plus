import { readFileSync } from 'fs';
import { join } from 'path';

describe('scoped user role uniqueness migration', () => {
  it('keeps the PostgreSQL partial indexes that enforce scoped role uniqueness', () => {
    // The three migrations that previously lived as separate files were
    // squashed into 20260601000000_init when we consolidated. Custom
    // partial / function-based indexes still need to be enforced, so
    // assert they survived the squash.
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma',
        'migrations',
        '20260601000000_init',
        'migration.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('user_roles_admin_unique');
    expect(migration).toContain('user_roles_organization_scope_unique');
    expect(migration).toContain('user_roles_department_scope_unique');
    expect(migration).toContain("WHERE \"role\" = 'ADMIN'");
    expect(migration).toContain('WHERE "organization_id" IS NOT NULL');
    expect(migration).toContain('WHERE "department_id" IS NOT NULL');
  });
});
