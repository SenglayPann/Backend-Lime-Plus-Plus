CREATE UNIQUE INDEX "user_roles_admin_unique"
  ON "user_roles"("user_id", "role")
  WHERE "role" = 'ADMIN' AND "organization_id" IS NULL AND "department_id" IS NULL;

CREATE UNIQUE INDEX "user_roles_organization_scope_unique"
  ON "user_roles"("user_id", "role", "organization_id")
  WHERE "organization_id" IS NOT NULL AND "department_id" IS NULL;

CREATE UNIQUE INDEX "user_roles_department_scope_unique"
  ON "user_roles"("user_id", "role", "department_id")
  WHERE "department_id" IS NOT NULL AND "organization_id" IS NULL;
