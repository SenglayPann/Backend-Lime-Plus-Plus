---
name: V3 Loophole Inspection
about: Track implementation of the V3 loophole inspection plan.
title: "V3 loophole inspection implementation"
labels: security, hardening
assignees: ""
---

## Phase Checklist

- [x] Phase 0 - Baseline and guardrails
- [x] Phase 1 - Stop sensitive data leaks
- [x] Phase 2 - Fix auth token transport and session refresh
  - Token-in-URL handoff, current-role refresh, refresh-token persistence/rotation, reuse detection, and logout revocation are implemented.
- [x] Phase 3 - Harden webhooks and project lock immutability
- [x] Phase 4 - Tighten role delegation and scope rules
- [ ] Phase 5 - Validation and data model corrections
  - Core project/task/score validation and duplicate scoring constraints are implemented.
  - Organization `license_plan` is still API-free-form and should become an enum or explicit allow-list.
- [x] Phase 6 - GitHub sync correctness
- [x] Phase 7 - Frontend authorization and UX reliability
- [ ] Phase 8 - Reports, exports, and operational hardening
  - Security headers, rate limits, CSV/PDF safety, and destructive delete guards are implemented.
  - Large report exports are still synchronous; browser `alert()`/`confirm()` flows still need app dialogs/toasts.
- [x] Phase 9 - Dependency remediation
  - High/critical advisories are remediated as of 2026-05-14.
  - Moderate Prisma/Next transitive advisories remain because current audit fixes require breaking/downgrade paths.

## Backend Focus

- [x] Replace client-facing full `User` includes with safe user selection.
- [x] Reject unsigned webhooks in production and explicit non-dev environments.
- [x] Preserve webhook delivery durability and replay safety.
- [x] Enforce project lock immutability for manual sync, webhook handlers, and score writes.
- [ ] Add model and DTO validation for malformed or race-prone input.
- [x] Remediate backend high/critical dependency advisories or document accepted exceptions.

## Latest Progress Snapshot

- Backend `b1ef821` imports unassigned GitHub Project V2 items instead of silently dropping them, allows nullable task assignees, keeps reports/dashboards stable for unassigned tasks, and covers webhook create/edit/PR validation paths.
- Frontend `c57086c` updates the Kanban sync summary so managers see unassigned tasks as imported instead of skipped.
- Backend `abf3599` revokes the descendant refresh-token chain when an already-rotated refresh token is reused.
- Frontend `31ac582` calls backend logout revocation before clearing the NextAuth session.
- Backend verification: `npm test -- --runInBand`, `npm run build`.
- Frontend verification: `npm test -- --runInBand --watchPathIgnorePatterns=.next`, `npm run build`.
- Current audit check: `npm audit --audit-level=high` passes in both repos. Moderate transitive advisories remain and need tracked release/upgrade decisions.

## Next Recommended Items

- Convert organization `license_plan` to a backend allow-list or enum and align frontend options.
- Replace browser `alert()`/`confirm()` export/delete flows with app dialogs and toasts.
- Decide whether large report exports need background jobs or streaming before production-scale usage.
