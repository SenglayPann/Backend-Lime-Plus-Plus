-- Add ARCHIVED variant to TaskStatus so task-sync handler can mark
-- tasks deleted on the GitHub Project board distinctly from manually
-- BLOCKED tasks (L7 from webhook handler audit).
ALTER TYPE "TaskStatus" ADD VALUE 'ARCHIVED';
