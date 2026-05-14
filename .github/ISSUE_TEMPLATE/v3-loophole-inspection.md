---
name: V3 Loophole Inspection
about: Track implementation of the V3 loophole inspection plan.
title: "V3 loophole inspection implementation"
labels: security, hardening
assignees: ""
---

## Phase Checklist

- [ ] Phase 0 - Baseline and guardrails
- [ ] Phase 1 - Stop sensitive data leaks
- [ ] Phase 2 - Fix auth token transport and session refresh
- [ ] Phase 3 - Harden webhooks and project lock immutability
- [ ] Phase 4 - Tighten role delegation and scope rules
- [ ] Phase 5 - Validation and data model corrections
- [ ] Phase 6 - GitHub sync correctness
- [ ] Phase 7 - Frontend authorization and UX reliability
- [ ] Phase 8 - Reports, exports, and operational hardening
- [ ] Phase 9 - Dependency remediation

## Backend Focus

- [ ] Replace client-facing full `User` includes with safe user selection.
- [ ] Reject unsigned webhooks in production and explicit non-dev environments.
- [ ] Preserve webhook delivery durability and replay safety.
- [ ] Enforce project lock immutability for manual sync, webhook handlers, and score writes.
- [ ] Add model and DTO validation for malformed or race-prone input.
- [ ] Remediate backend dependency advisories or document accepted exceptions.
