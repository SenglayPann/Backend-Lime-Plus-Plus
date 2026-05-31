-- Idea 1: allowlist entries gain a lifecycle (PENDING / APPROVED / REJECTED)
-- and a flag distinguishing manually-typed entries from ones Lime++
-- auto-created when an unknown contributor first showed up.

CREATE TYPE "AllowlistStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "organization_allowlist_entries"
    ADD COLUMN "status" "AllowlistStatus" NOT NULL DEFAULT 'APPROVED',
    ADD COLUMN "auto_created" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "approved_by_user_id" TEXT,
    ADD COLUMN "approved_at" TIMESTAMP(3);

-- Backfill: every entry that existed before this migration was added by an
-- org manager via the UI, so it counts as implicitly approved. Stamp the
-- approval with the entry's creator + creation time so the audit trail
-- reflects what actually happened.
UPDATE "organization_allowlist_entries"
   SET "approved_by_user_id" = "added_by_id",
       "approved_at"         = "created_at"
 WHERE "status" = 'APPROVED' AND "approved_at" IS NULL;

ALTER TABLE "organization_allowlist_entries"
    ADD CONSTRAINT "organization_allowlist_entries_approved_by_user_id_fkey"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "organization_allowlist_entries_organization_id_status_idx"
    ON "organization_allowlist_entries"("organization_id", "status");
