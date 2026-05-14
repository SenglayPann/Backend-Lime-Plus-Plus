# V3 Loophole Inspection Phase 0 Baseline

Date: 2026-05-14

Scope: backend workspace.

## Baseline Commands

| Command | Result |
| --- | --- |
| `npm test` | Passed: 24 suites, 153 tests |
| `npm run build` | Passed |
| `npm audit --audit-level=high` | Failed: 38 vulnerabilities; 1 critical, 20 high, 16 moderate, 1 low |

## Notes

- `npm test` logs an expected error-path message from `WebhookProcessor` while still passing.
- `npm run build` regenerated the Prisma client and completed without source changes.
- The audit result still includes production-facing NestJS and transitive advisories, plus Prisma/dev-tooling advisories. Dependency remediation remains Phase 9 work.

## Guardrail Tests Added

- Sensitive response guard helper for detecting forbidden fields such as `githubAccessToken`.
- Task response serialization regression coverage for safe user selection.
- Production webhook signature regression coverage for missing `GITHUB_WEBHOOK_SECRET`.
