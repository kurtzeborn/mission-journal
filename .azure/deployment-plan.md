# Azure Deployment Plan

> **Status:** Validated

## Goal

Delete obsolete generated-book drafts when a newer book finishes successfully.

## Confirmed behavior

- The owner UI links only the newest generated draft.
- A separately pinned sale version may be older than the newest draft.
- `order.json` identifies a book that has had a checkout page created.
- Books with checkout metadata must be retained; prior folders without checkout metadata are no longer reachable from the UI.

## Change

- Add cleanup to the existing background book worker after the new book is fully written and marked ready.
- Delete only book folders whose sortable book ID is older than the completed book.
- Preserve the completed book, any newer/concurrent build, and every folder containing `order.json`.
- Treat cleanup as non-critical housekeeping: log storage failures without changing a successfully built book to failed.
- Add focused tests for deletion, checkout preservation, concurrent/newer build preservation, and cleanup failure behavior.

## Infrastructure and deployment

- No infrastructure, subscription, region, identity, or production-target changes.
- Deploy through the existing GitHub Actions **Deploy functions** workflow after merge to `main`.

## Validation Proof

| Check | Command | Result |
|-------|---------|--------|
| Focused behavior | `node --test functions\tests\publish.test.js` | 28 passed |
| Full Functions suite | `npm --prefix functions test` | 1,891 passed, 11 intentional DKIM fixture skips |
| Dependency audit | `npm --prefix functions run audit` | 0 advisories |
| Diff integrity | `git diff --check` | Passed |
| Build/package verification | Existing Functions workflow and package structure reviewed | No separate build script; deployment performs the remote Node 24 build |
| Infrastructure/RBAC | Reviewed change scope | No infrastructure or role-assignment changes |
