# Azure Deployment Plan

> **Status:** Validated

Generated: 2026-09-21

## 1. Project Overview

**Goal:** Add secure, reader-only QR invitations to the People page for in-person family gatherings.

**Path:** Modify the existing production web, Functions, and storage-table configuration.

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Production |
| Scale | Small |
| Budget | Cost-optimized |
| Subscription | Existing CI/CD target: MSDN Subscription (`41fbccc1-bb65-416d-816d-30cb2a41dd9b`) |
| Location | Existing resources: Central US |

The established GitHub Actions workflows remain the deployment path. No new Azure service, SKU, region, identity, or secret is introduced.

## 3. Security Design

- Only a current archive owner can start, rotate, or close a QR invitation.
- QR invitations always grant reader access; ownership remains an explicit later action.
- The displayed signed bearer credential expires after 30 seconds.
- A scan exchanges that credential for a one-time, tab-scoped ticket lasting up to 10 minutes for sign-in.
- The ticket is usable only while the owner-controlled session remains active.
- Closing the dialog revokes the session immediately; an abandoned session expires after 90 seconds.
- Atomic Azure Table transactions reserve one of 50 session slots and create the redemption together.
- Completed tickets cannot restore access after an owner removes the reader.
- The signed token stays in the URL fragment, is moved into `sessionStorage`, and is stripped from the address bar.
- QR rendering is local; no invitation URL is sent to a third-party service.

## 4. Components

| Component | Technology | Change |
|-----------|------------|--------|
| People page | Static HTML/CSS/JavaScript | Reader-only QR invitation dialog and rotation |
| Join page | Static HTML/JavaScript | Anonymous exchange, sign-in, and ticket acceptance |
| Invitation API | Azure Functions, Node.js | Owner session lifecycle, exchange, and acceptance |
| State | Azure Table Storage | `qrInvites` and `qrRedemptions` tables |
| Infrastructure | Bicep | Provision the two tables |
| Browser dependency | `qrcode-generator` | Vendored local QR rendering |

## 5. Deployment Recipe

**Selected:** Existing GitHub Actions CI/CD.

- `infra/**` provisions the two table resources through **Deploy infrastructure** when permitted.
- `functions/**` deploys the API through **Deploy functions**.
- `web/**` deploys the interface through **Deploy web**.

Infrastructure must complete before the new Functions endpoints receive production traffic.

## 6. Provisioning Limits

| Resource Type | New | Total Impact | Limit/Quota |
|---------------|-----|--------------|-------------|
| Azure Storage tables | 2 | Two tables in the existing storage account | No meaningful quota impact |

## 7. Validation Proof

Validated: 2026-09-21 15:42:48 -07:00

| Check | Command | Result |
|-------|---------|--------|
| Bicep compilation | `az bicep build --file infra\main.bicep --stdout` | Passed |
| Bicep lint | `az bicep lint --file infra\main.bicep` | Passed |
| ARM validation | `az deployment group validate --resource-group mission-journal --template-file infra\main.bicep --parameters infra\main.bicepparam` | `Succeeded` |
| ARM what-if | `az deployment group what-if ... --result-format ResourceIdOnly` | Passed; creates only `qrInvites` and `qrRedemptions`, with the template's existing deployment noise |
| Azure authentication | `az account show` | Authenticated to the established MSDN Subscription |
| Azure policy | `az policy assignment list ...`; `az policy state summarize --resource-group mission-journal` | No assignments or reported noncompliance |
| Full Functions suite | `npm --prefix functions test` | 1,847 passed, 11 skipped, 0 failed |
| Focused QR and store tests | `node --test functions\tests\qr-invite.test.js functions\tests\web-join.test.js functions\tests\web-people.test.js functions\tests\store-contract.test.js` | 54 passed, 0 failed |
| Functions dependencies | `npm --prefix functions run audit` | 0 advisories |
| Web dependencies | `npm audit --prefix web --audit-level=high` | 0 vulnerabilities |
| Vendored assets | `npm --prefix web run vendor:check` | 11 files match |
| Stylesheet synchronization | SHA-256 comparison | Passed |
| Static Web Apps config | PowerShell `ConvertFrom-Json` | Passed |
| Diff integrity | `git diff --check` | Passed |

### Role Assignment Verification

- **Identity:** System-assigned identity of `mj-fn-utfe5uagkbz7q`.
- **Required operation:** Read and write invitation/session entities in Azure Table Storage.
- **Declared role:** `Storage Table Data Contributor`, scoped to the existing storage account.
- **Live role:** The same data-plane role is already assigned at storage-account scope, so it covers the two new tables.
- **Other identities:** No new identity or role assignment is introduced by this feature.

## 8. Execution Checklist

### Planning and implementation
- [x] Review existing authentication, invitation, and ACL behavior
- [x] Confirm reader-only QR access with the user
- [x] Implement owner-controlled rotating sessions
- [x] Implement single-use sign-in tickets
- [x] Add local QR rendering and join UI
- [x] Add Bicep table resources
- [x] Run a focused security review
- [x] Fix replay-after-removal and concurrent-cap findings
- [x] Run focused and full automated tests
- [x] Set status to Ready for Validation

### Validation
- [x] Invoke azure-validate
- [x] Bicep compilation
- [x] Template validation
- [x] What-if preview
- [x] Authentication
- [x] Bicep lint
- [x] Azure policy validation
- [x] Build and test verification
- [x] Static role verification
- [x] Record validation proof
- [x] Set status to Validated

### Deployment
- [ ] Merge the pull request to `main`
- [ ] Confirm infrastructure, Functions, and web deployments
- [ ] Verify the production QR invitation flow

## 9. Files

- `web/people.html`, `web/people.js`, `web/styles.css`
- `web/join.html`, `web/join.js`
- `web/vendor/qrcode.js`, `web/package.json`, `web/package-lock.json`
- `web/staticwebapp.config.json`
- `functions/src/functions/qrinvite.js`
- `functions/src/lib/qrinvite.js`, `claimtoken.js`, `tables.js`
- `functions/tests/qr-invite.test.js`, `web-join.test.js`, `web-people.test.js`
- `infra/main.bicep`, `infra/provision-claim.ps1`

## 10. Next Steps

Release approval was confirmed on 2026-09-21. Merge the pull request and verify all three production workflows and the live site.
