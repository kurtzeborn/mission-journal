# Azure Deployment Plan

> **Status:** Validated

Generated: 2026-09-13

---

## 1. Project Overview

**Goal:** Publish the new static `Who Made This?` page, optimized photograph, and navigation links.

**Path:** Modify an existing production application.

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production |
| Scale | Small |
| Budget | Cost-optimized |
| Subscription | Existing CI/CD target: MSDN Subscription (`41fbccc1-bb65-416d-816d-30cb2a41dd9b`) |
| Location | Existing Static Web App: Central US |

The user explicitly directed this release to use the established CI/CD deployment. No subscription, region, resource, SKU, or infrastructure decision is part of this change.

---

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Public website | Frontend | Static HTML, CSS, and assets | `web/` |
| Deployment workflow | CI/CD | GitHub Actions and Azure Static Web Apps deploy action | `.github/workflows/deploy-web.yml` |

---

## 4. Recipe Selection

**Selected:** Existing CI/CD

**Rationale:** A push to `main` that changes `web/**` automatically runs the established **Deploy web** workflow. It validates vendored browser dependencies and uploads `web/` to the existing Azure Static Web App without rebuilding or provisioning infrastructure.

---

## 5. Architecture

**Stack:** Static Web Apps

| Component | Azure Service | SKU |
|-----------|---------------|-----|
| Public website | Azure Static Web Apps (`mj-swa-utfe5uagkbz7q`) | Standard |

No supporting service or infrastructure changes are required.

---

## 6. Provisioning Limit Checklist

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota | Notes |
|---------------|------------------|------------------------|-------------|-------|
| Azure resources | 0 | Unchanged | Not applicable | Static content upload to an existing resource; no provisioning |

**Status:** No quota or capacity change.

---

## 7. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace
- [x] Gather requirements
- [x] Confirm existing CI/CD target with user
- [x] Confirm no resources will be provisioned
- [x] Scan codebase
- [x] Select existing CI/CD recipe
- [x] Confirm architecture remains unchanged
- [x] User approved this deployment path

### Phase 2: Execution
- [x] Add the static page, image, navigation, and styles
- [x] Preserve the packaged-reader stylesheet copy
- [x] Verify internal links and packaged assets
- [x] Set status to Ready for Validation

### Phase 3: Validation
- [x] Invoke azure-validate
- [x] Record validation proof below

### Phase 4: Deployment
- [ ] Merge the pull request to `main`
- [ ] Confirm the **Deploy web** workflow succeeds
- [ ] Verify the live page and navigation

---

## 8. Validation Proof

| Check | Command Run | Result | Timestamp |
|-------|-------------|--------|-----------|
| Vendored web assets | `npm run vendor:check` in `web/` | Pass: 10 files match | 2026-09-14T04:57:23Z |
| Page links and packaged assets | `node --test tests/web-links.test.js tests/archive.test.js` in `functions/` | Pass: 22 tests | 2026-09-14T04:57:23Z |
| Static Web Apps routes | Parse `web/staticwebapp.config.json` and assert `/about`, `/about.html`, and `/who-made-this.jpg` allow `anonymous` | Pass | 2026-09-14T04:57:23Z |
| Diff integrity | `git diff --check` | Pass | 2026-09-14T04:57:23Z |
| Static RBAC review | No infrastructure or role-assignment changes | Not applicable | 2026-09-14T04:57:23Z |

**Validated by:** azure-validate skill  
**Validation timestamp:** 2026-09-14T04:57:23Z

---

## 9. Files

| File | Purpose | Status |
|------|---------|--------|
| `web/about.html` | Public Who Made This page | Ready |
| `web/who-made-this.jpg` | Optimized page photograph | Ready |
| `web/index.html` | Footer link | Ready |
| `web/faq.html` | Footer link | Ready |
| `web/start.html` | Footer link | Ready |
| `web/styles.css` | About-page image layout | Ready |
| `web/staticwebapp.config.json` | Anonymous routes for the page and photograph | Ready |
| `functions/src/assets/reader/styles.css` | Required synchronized stylesheet copy | Ready |
| `functions/tests/web-links.test.js` | Footer-link regression coverage | Ready |
| `.github/copilot-instructions.md` | Persist the established CI/CD release convention | Ready |

---

## 10. Next Steps

1. Validate the prepared release.
2. Merge to `main`.
3. Let the existing **Deploy web** workflow publish the site.
4. Verify `https://pdayletters.com/about`.
