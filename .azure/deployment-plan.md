# Azure Deployment Plan

> **Status:** Deployed

Generated: 2026-09-14

## 1. Project Overview

**Goal:** Replace the inline “invited as …” text on the People page with the same compact, accessible information disclosure used on the Settings page.

**Path:** Modify an existing production application.

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production |
| Scale | Small |
| Budget | Cost-optimized |
| Subscription | Existing CI/CD target: MSDN Subscription (`41fbccc1-bb65-416d-816d-30cb2a41dd9b`) |
| Location | Existing Static Web App: Central US |

The user explicitly approved merging and deploying this UI change. The established GitHub Actions deployment target and infrastructure remain unchanged.

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| People page | Frontend | Static HTML, CSS, and JavaScript | `web/people.html`, `web/people.js`, `web/styles.css` |
| Packaged reader assets | Function asset | Synchronized CSS copy | `functions/src/assets/reader/styles.css` |
| Regression tests | Tests | Node test runner and lightweight DOM | `functions/tests/web-people.test.js` |
| Deployment workflows | CI/CD | GitHub Actions | `.github/workflows/` |

## 4. Recipe Selection

**Selected:** Existing CI/CD.

A merge to `main` changing `web/**` runs **Deploy web**. The synchronized stylesheet under `functions/**` also runs **Deploy functions**. No Azure resources are provisioned or changed.

## 5. Architecture

| Component | Azure Service | SKU |
|-----------|---------------|-----|
| Public website | Azure Static Web Apps (`mj-swa-utfe5uagkbz7q`) | Standard |
| Existing API and packaged assets | Azure Functions | Existing |

## 6. Provisioning Limit Checklist

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota |
|---------------|------------------|------------------------|-------------|
| Azure resources | 0 | Unchanged | Not applicable |

## 7. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace and existing disclosure pattern
- [x] Confirm existing CI/CD deployment target
- [x] Confirm no infrastructure or access changes
- [x] Record user approval

### Phase 2: Execution
- [x] Replace inline invitation address with an accessible information disclosure
- [x] Keep synchronized stylesheets byte-identical
- [x] Add regression coverage
- [x] Run focused validation
- [x] Set status to Ready for Validation

### Phase 3: Validation
- [x] Invoke azure-validate
- [x] Record validation proof

### Phase 4: Deployment
- [x] Merge the pull request to `main`
- [x] Confirm automatic GitHub Actions deployments succeed
- [x] Verify the authenticated production surface and API health check

## 8. Validation Proof

| Check | Command Run | Result | Timestamp |
|-------|-------------|--------|-----------|
| Automated tests | `npm --prefix functions test` | Pass: 1,828 passed, 11 skipped, 0 failed | 2026-09-15T02:04:00Z |
| Vendored web assets | `npm --prefix web run vendor:check` | Pass: 10 files match | 2026-09-15T02:04:00Z |
| Stylesheet synchronization | Compare SHA-256 hashes of both stylesheet copies | Pass: identical | 2026-09-15T02:04:00Z |
| Diff integrity | `git diff --check` | Pass | 2026-09-15T02:04:00Z |
| Static RBAC review | No infrastructure, identity, or role-assignment changes | Not applicable | 2026-09-15T02:04:00Z |

**Validated by:** azure-validate skill  
**Validation timestamp:** 2026-09-15T02:04:00Z

### Deployment Verification

| Check | Result | Timestamp |
|-------|--------|-----------|
| Pull request merge | Merge commit `a0a953c11baa7eaabe9284ec9b450e997d3b183a` | 2026-09-15T02:04:52Z |
| **Deploy web** run `34919792727` | Pass | 2026-09-15 |
| **Deploy functions** run `34919792713` | Pass, including tests and API health check | 2026-09-15 |
| `https://pdayletters.com/people.js` anonymous request | Correctly protected by sign-in redirect | 2026-09-15 |

### Live Role Verification

No resources, managed identities, role assignments, or infrastructure were provisioned or changed. Live RBAC verification is not applicable.

## 9. Files

| File | Purpose |
|------|---------|
| `web/people.js` | Render the invitation-address disclosure |
| `web/styles.css` | Anchor the existing disclosure panel within a People row |
| `functions/src/assets/reader/styles.css` | Required synchronized stylesheet copy |
| `functions/tests/web-people.test.js` | Verify compact and accessible rendering |

## 10. Next Steps

Deployment is complete at `https://pdayletters.com`.
