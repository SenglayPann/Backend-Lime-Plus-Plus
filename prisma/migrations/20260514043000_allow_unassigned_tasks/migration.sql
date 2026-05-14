ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_assignee_id_fkey";

ALTER TABLE "tasks" ALTER COLUMN "assignee_id" DROP NOT NULL;

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_assignee_id_fkey"
FOREIGN KEY ("assignee_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
