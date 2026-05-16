ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "github_repository_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "projects_github_repository_id_key"
  ON "projects"("github_repository_id")
  WHERE "github_repository_id" IS NOT NULL;
