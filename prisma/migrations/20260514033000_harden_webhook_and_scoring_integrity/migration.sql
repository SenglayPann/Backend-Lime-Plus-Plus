ALTER TABLE "webhook_deliveries"
  ADD COLUMN "queued_at" TIMESTAMP(3),
  ADD COLUMN "processing_started_at" TIMESTAMP(3),
  ADD COLUMN "failed_at" TIMESTAMP(3),
  ADD COLUMN "last_error" TEXT;

ALTER TABLE "pr_reviews"
  ADD COLUMN "external_review_id" TEXT;

CREATE UNIQUE INDEX "pr_reviews_pull_request_id_external_review_id_key"
  ON "pr_reviews"("pull_request_id", "external_review_id");

CREATE UNIQUE INDEX "contribution_events_project_id_user_id_type_reference_id_key"
  ON "contribution_events"("project_id", "user_id", "type", "reference_id");
