# Azure Deployment Plan

> **Status:** Deployed

Generated: 2026-09-13

---

## 1. Project Overview

**Goal:** Remove the personal photograph from the public `Who Made This?` page and from the deployed site.

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

The user explicitly directed ordinary releases to use the established CI/CD deployment. No subscription, region, resource, SKU, or infrastructure decision is part of this change.

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
- [x] Remove the photograph from the page and repository
- [x] Remove its anonymous route and unused styles
- [x] Preserve the packaged-reader stylesheet copy
- [x] Verify internal links and packaged assets
- [x] Set status to Ready for Validation

### Phase 3: Validation
- [x] Invoke azure-validate
- [x] Record validation proof below

### Phase 4: Deployment
- [x] Merge the pull request to `main`
- [x] Confirm the **Deploy web** workflow succeeds
- [x] Confirm the synchronized reader asset passes the **Deploy functions** workflow
- [x] Verify the live page no longer references the photograph
- [x] Verify the photograph URL no longer serves the image

---

## 8. Validation Proof

| Check | Command Run | Result | Timestamp |
|-------|-------------|--------|-----------|
| Vendored web assets | `npm run vendor:check` in `web/` | Pass: 10 files match | 2026-09-14T05:55:18Z |
| Page links and packaged assets | `node --test tests/web-links.test.js tests/archive.test.js` in `functions/` | Pass: 22 tests | 2026-09-14T05:55:18Z |
| Photograph removal | Assert no file or HTML/config/CSS reference remains | Pass | 2026-09-14T05:55:18Z |
| Static Web Apps configuration | Parse `web/staticwebapp.config.json` | Pass | 2026-09-14T05:55:18Z |
| Stylesheet synchronization | Compare SHA-256 hashes of both stylesheet copies | Pass | 2026-09-14T05:55:18Z |
| Diff integrity | `git diff --check` | Pass | 2026-09-14T05:55:18Z |
| Static RBAC review | No infrastructure or role-assignment changes | Not applicable | 2026-09-14T05:55:18Z |

**Validated by:** azure-validate skill  
**Validation timestamp:** 2026-09-14T05:55:18Z

### Deployment Verification

| Check | Result | Timestamp |
|-------|--------|-----------|
| **Deploy web** GitHub Actions run `34811471537` | Pass | 2026-09-14 |
| **Deploy functions** GitHub Actions run `34811471513` | Pass | 2026-09-14 |
| `https://pdayletters.com/about` | Public page contains no photograph reference | 2026-09-14 |
| `https://pdayletters.com/who-made-this.jpg` | No image served; HTTP 401 from the authenticated catch-all | 2026-09-14 |

### Live Role Verification

No resources, managed identities, role assignments, or infrastructure were provisioned or changed by this static-content deployment. Live RBAC verification is not applicable.

---

## 9. Files

| File | Purpose | Status |
|------|---------|--------|
| `web/about.html` | Public Who Made This page | Ready |
| `web/who-made-this.jpg` | Remove personal photograph | Removed |
| `web/index.html` | Footer link | Ready |
| `web/faq.html` | Footer link | Ready |
| `web/start.html` | Footer link | Ready |
| `web/styles.css` | Remove unused photograph layout | Ready |
| `web/staticwebapp.config.json` | Remove the photograph's anonymous route | Ready |
| `functions/src/assets/reader/styles.css` | Required synchronized stylesheet copy | Ready |
| `functions/tests/web-links.test.js` | Footer-link regression coverage | Ready |
| `.github/copilot-instructions.md` | Persist the established CI/CD release convention | Ready |

---

## 10. Next Steps

Deployment is complete at `https://pdayletters.com/about`.
