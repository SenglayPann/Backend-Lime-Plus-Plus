UPDATE "user_roles"
SET "organization_id" = NULL,
    "department_id" = NULL
WHERE "role" = 'ADMIN';

DELETE FROM "user_roles"
WHERE "role" IN ('PROJECT_MANAGER', 'PROJECT_MEMBER');
