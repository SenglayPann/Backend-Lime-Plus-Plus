import { readFileSync } from 'fs';
import { join } from 'path';

describe('scoped user role uniqueness migration', () => {
  it('keeps the PostgreSQL partial indexes that enforce scoped role uniqueness', () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma',
        'migrations',
        '20260514034500_add_scoped_user_role_unique_indexes',
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
