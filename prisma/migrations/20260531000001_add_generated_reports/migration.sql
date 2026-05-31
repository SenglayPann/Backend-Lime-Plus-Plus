-- Append-only ledger of every PDF report Lime++ has emitted. The row id
-- is the public verification token printed on the PDF; data_hash +
-- signature let a third party confirm authenticity via the public
-- verify endpoint without needing a Lime++ account.
CREATE TABLE "generated_reports" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "subject_user_id" TEXT,
    "generated_by_user_id" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data_hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "generated_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "generated_reports_project_id_generated_at_idx"
    ON "generated_reports"("project_id", "generated_at");

ALTER TABLE "generated_reports"
    ADD CONSTRAINT "generated_reports_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_reports"
    ADD CONSTRAINT "generated_reports_subject_user_id_fkey"
    FOREIGN KEY ("subject_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "generated_reports"
    ADD CONSTRAINT "generated_reports_generated_by_user_id_fkey"
    FOREIGN KEY ("generated_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
