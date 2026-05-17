CREATE UNIQUE INDEX "organizations_name_unique_normalized"
  ON "organizations"(LOWER(BTRIM("name")));

CREATE UNIQUE INDEX "departments_organization_name_unique_normalized"
  ON "departments"("organization_id", LOWER(BTRIM("name")));
