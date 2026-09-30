# Facebook Authentication Deployment Plan

> **Status:** Validated

Updated: 2026-09-29

## 1. Goal

Add **Continue with Facebook** alongside Google and Microsoft without replacing
the existing Azure Static Web Apps authentication boundary.

The finished flow must preserve:

- Deep-link returns after sign-in.
- Remembered-provider behavior.
- Stable membership identity using `provider:userId`.
- Email invitation acceptance.
- QR Quick join acceptance.
- Owner and operator authorization.
- Existing Google and Microsoft sign-in behavior.

## 2. Current architecture

| Area | Current behavior | Facebook change |
|------|------------------|-----------------|
| Authentication edge | Azure Static Web Apps Standard custom authentication | Add its built-in `facebook` provider |
| Backend trust | Linked Functions trust only the Static Web Apps principal header | No new backend identity provider |
| Membership identity | Email plus stable `provider:userId` | Facebook becomes `facebook:<userId>` |
| Secrets | OAuth secrets live in Azure Key Vault and reach Static Web Apps through references | Store the Meta App Secret the same way |
| UI | Google and Microsoft links appear on five sign-in surfaces | Add Facebook consistently to all five |
| Deployment | GitHub Actions deploys `infra/**`, `web/**`, and `functions/**` | Use the same workflows |

## 3. Owner prerequisites: complete these first

Facebook Login has no annual provider fee. The setup requires a normal Facebook
account, a free Meta developer registration, and a Meta application.

### 3.1 Prepare the controlling Facebook account

Use an account that will remain under long-term control of PdayLetters.

1. Confirm the Facebook account has a verified email address.
2. Confirm it has a mobile phone number; Meta requires email and phone
   verification during developer registration.
3. Enable two-factor authentication.
4. Review the account recovery email and phone number.
5. Do not use a contractor's or disposable personal account.

### 3.2 Register as a Meta developer

1. Sign in to Facebook.
2. Open <https://developers.facebook.com/async/registration>.
3. Accept the Meta Platform Terms and Developer Policies.
4. Complete the email and phone verification challenge.
5. Select the occupation that most closely fits.

There is no charge for this registration.

### 3.3 Create the Meta application

Open <https://developers.facebook.com/apps/creation/> and use:

| Field | Recommended value |
|-------|-------------------|
| App name | `Pday Letters` |
| Contact email | A monitored long-term PdayLetters contact address |
| Use case | **Authenticate and request data from users with Facebook Login** |
| Business portfolio | Select an existing PdayLetters portfolio if one exists; otherwise choose **I don't want to connect to a business portfolio yet** |

Do not add unrelated use cases. Meta does not allow a use case to be removed
after it is added.

### 3.4 Fill in the app's Basic settings

In **App settings → Basic**, configure:

| Setting | Value |
|---------|-------|
| Display name | `Pday Letters` |
| App domain | `pdayletters.com` |
| Website URL | `https://pdayletters.com/` |
| Privacy Policy URL | `https://pdayletters.com/privacy` |
| Terms of Service URL | `https://pdayletters.com/terms` |
| User Data Deletion URL | `https://pdayletters.com/privacy#data-deletion` after that section is deployed |
| Category | The closest available general consumer/family category |
| App purpose | People outside the app's owning business |
| App icon | A square PdayLetters app icon that does not incorporate Meta branding |

The repository implementation will add the explicit `data-deletion` section
before the app is published. Until that is deployed, leave the deletion URL
unfinished rather than pointing it at instructions that do not exist.

### 3.5 Configure Facebook Login

In **Facebook Login → Settings**:

1. Keep **Client OAuth Login** enabled.
2. Add this exact Valid OAuth Redirect URI:

   `https://pdayletters.com/.auth/login/facebook/callback`

3. Save the configuration.
4. Do not enable the JavaScript SDK merely for this integration. Azure Static
   Web Apps performs the redirect and token exchange server-side.
5. Do not add broad permissions. PdayLetters needs only the standard basic
   profile and email information used for authentication.

A non-production Static Web Apps hostname may be added later for real staging
tests. It should not be guessed or registered until that test environment is
selected.

### 3.6 Record the App ID and secure the App Secret

In **App settings → Basic**:

1. Record the numeric **App ID**. It is a public client identifier.
   PdayLetters App ID: `1144678524889057`.
2. Select **Show** beside **App Secret** and record it in an encrypted password
   manager or secret vault.
3. Never put the App Secret in Git, an issue, email, screenshots, or chat.
4. Do not paste the App Secret into this conversation.

When implementation begins, the secret will be entered directly into Azure Key
Vault through an authenticated local or Azure command, not copied into source.
Meta App Secrets do not use Apple's expiring JWT model, but resetting one is a
manual and disruptive operation. Rotate it on suspected exposure or ownership
change and document who controls the Meta app.

### 3.7 Add test access and keep the app unpublished

While the app remains in development:

1. The Facebook account that created it can test as an administrator.
2. Add a second real account as a Tester or Developer if available.
3. Use accounts with verified email addresses for the initial Azure principal
   capture.
4. Keep the app unpublished until the PdayLetters configuration, privacy text,
   missing-email handling, and end-to-end tests are ready.

### 3.8 What to bring back

Return with:

- Confirmation that Meta developer registration is complete.
- The **App ID**.
- Confirmation that the App Secret is stored securely; do not send its value.
- Confirmation that `pdayletters.com` and the production callback are saved.
- Whether the app is attached to a Meta business portfolio.
- Any requirements Meta's **Publish** or **App Review** pages show for this app.

Meta's current documentation says `public_profile` and `email` are available to
Facebook Login apps without a separate advanced-permission review. The app
still must satisfy the dashboard's publication requirements before accounts
without an app role can use it. Business Verification is normally needed for
advanced access, not for this minimal login, but the live dashboard is the
authority for the specific app.

## 4. Identity and account behavior

### 4.1 Required real-principal verification

Before public rollout, sign in through the configured test environment and
capture only the non-sensitive shape of `/.auth/me`:

- `identityProvider` must be `facebook`.
- `userId` must be present and stable across sign-ins.
- `userDetails` must contain a usable email address for an account that grants
  email access.

Do not record access tokens, cookies, the App Secret, or the full raw principal
in source control.

### 4.2 Missing email

Facebook does not guarantee an email for every account. An account may be
phone-only, have no usable verified email, or omit the email claim.

**Planned behavior:** refuse that Facebook sign-in with a clear explanation:

> Facebook did not provide an email address. Add a verified email to Facebook,
> or continue with Google or Microsoft.

Do not:

- Invent a synthetic email address.
- Match by name.
- Grant an invitation using only the Facebook profile ID.
- Silently treat the visitor as anonymous.

PdayLetters invitations, memberships, digest preferences, operator access, and
account explanations all depend on a usable address.

### 4.3 Existing memberships and account linking

The existing rule remains:

- If Facebook returns the same email already invited to an archive, that
  account can accept or reach the membership and is stamped with the stable
  `facebook:<userId>` identity.
- The same human using different providers with the same email remains
  intentionally compatible.
- If Facebook returns a different email, PdayLetters does not guess that it is
  the same person. An owner must invite that address or the user must choose
  the provider carrying the invited address.

## 5. Repository implementation

### 5.1 Infrastructure and protected settings

Update `infra/main.bicep` to add:

- Public `facebookAppId` parameter.
- Key Vault secret name parameter, expected to be
  `facebook-app-secret`.
- Static Web App settings:
  - `FACEBOOK_APP_ID`
  - `FACEBOOK_APP_SECRET`

`FACEBOOK_APP_SECRET` will be a Key Vault reference. The linked Functions app
does not need this secret because authentication remains at the Static Web Apps
edge. Do not enable Facebook Easy Auth directly on the Functions backend.

Use `infra/provision-facebook.ps1` to place the secret in Key Vault without
putting it in shell history or deployment output.

### 5.2 Static Web Apps provider

Update `web/staticwebapp.config.json`:

```json
"facebook": {
  "userDetailsClaim": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "registration": {
    "appIdSettingName": "FACEBOOK_APP_ID",
    "appSecretSettingName": "FACEBOOK_APP_SECRET"
  },
  "login": {
    "scopes": ["public_profile", "email"]
  }
}
```

The explicit `email` scope and email-address `userDetailsClaim` are required
for Azure Static Web Apps to complete the Facebook identity with the
email-shaped `userDetails` PdayLetters uses. Without them, Facebook consent can
succeed while the Azure callback returns `403 Forbidden` or no usable
principal. Google and Microsoft remain configured. Adding Facebook must not
change route authorization or the linked-backend trust boundary.

### 5.3 Sign-in UI

Add Facebook to:

- `web/login.html` and `web/login.js`
- `web/claim.html`
- `web/invite.html`
- `web/join.html` and `web/join.js`
- `web/email.html`
- `web/page.js`

Use `/.auth/login/facebook` and preserve each page's existing
`post_login_redirect_uri`.

Add Facebook to remembered-provider behavior so a returning user can be sent
back through Facebook once, with the same loop prevention and sign-out reset
used for Google and Microsoft.

Use the Font Awesome Facebook brand icon already provided by the vendored icon
set; do not load Meta's JavaScript SDK.

### 5.4 Principal and error handling

Update `functions/src/lib/principal.js` and the nearest authentication response
path so a missing email is distinguishable from an unauthenticated request.
Return a safe, actionable response to the browser rather than allowing a
success-shaped anonymous fallback.

Confirm that:

- `identityKey()` naturally produces `facebook:<userId>`.
- ACL lookup continues to prefer stable identity and then email.
- Invitation and QR acceptance retain their existing authorization checks.
- Operator rights still require the configured email address.

### 5.5 Privacy and deletion copy

Update `web/terms.html` to:

- Name Facebook alongside Google and Microsoft.
- Explain that PdayLetters receives the account email, display name, and stable
  provider identifier, not the Facebook password.
- Add `id="data-deletion"` with explicit instructions for removing a Facebook
  identity and associated PdayLetters data.
- Explain the distinction between removing one membership and deleting an
  archive.

Use `https://pdayletters.com/privacy#data-deletion` in the Meta dashboard only
after that section is live.

## 6. Tests and verification

### Automated coverage

- Static Web Apps config includes all three providers and correct setting
  names.
- Every sign-in surface includes Facebook.
- Deep-link return paths are preserved.
- Remembered Facebook provider retries once and is cleared by sign-out.
- Claim, email invitation, and QR join flows point Facebook back to the correct
  page.
- `facebook:<userId>` is stable and provider-scoped.
- Same-email memberships work across providers.
- Missing Facebook email is refused with the intended explanation.
- Google and Microsoft behavior remains unchanged.
- Privacy and data-deletion URLs are present.
- Bicep compiles and references the Key Vault secret without exposing it.

### Real-account staging matrix

Test:

1. Facebook account with a verified email.
2. Second Facebook account with a verified email.
3. Account for which Facebook does not return email, if one can be safely
   created or configured.
4. Existing Google/Microsoft member signing in through Facebook with the same
   email.
5. Invitation acceptance.
6. Quick join acceptance.
7. Deep link to a protected archive.
8. Logout and **try another account**.
9. Revocation/removal of PdayLetters from Facebook's Apps and Websites
   settings, followed by sign-in again.

## 7. Release sequence

1. Complete Meta prerequisites while the app remains unpublished.
2. Approve this plan.
3. Confirm the established Azure subscription and production region before
   changing protected infrastructure settings.
4. Implement infrastructure, web, Functions, tests, and privacy copy.
5. Update this plan to **Ready for Validation**.
6. Run the Azure validation workflow.
7. Deploy through the existing production workflows with the Facebook buttons
   hidden. The app administrator reaches the staged provider only through
   `/login.html?facebook_test=1`.
8. Resolve any principal or email-shape differences.
9. Complete Meta's required publication checks and switch the app live.
10. Open and merge a pull request to `main`.
11. Verify the path-triggered infrastructure, web, and Functions workflows.
12. Verify production sign-in and all invitation paths.

## 8. Cost and operational impact

| Item | Expected cost |
|------|---------------|
| Meta developer account | $0 |
| Facebook Login basic authentication | $0 |
| Azure Static Web Apps | No new SKU; existing Standard plan |
| Key Vault secret | Negligible within existing vault usage |
| Ongoing operation | Meta policy notices, app ownership, publication status, and manual secret recovery/rotation |

## 9. Approval gate

No authentication, infrastructure, secret, or production change should be made
until:

- The Meta App ID exists.
- The App Secret is securely retained.
- The production callback is registered.
- [x] The user approved this implementation plan on 2026-09-29.

## 10. Preparation record

- [x] Meta App ID `1144678524889057` recorded.
- [x] Production callback registered and verified in Meta.
- [x] `facebook-app-secret` stored and enabled in Key Vault
  `mj-kv-utfe5uagkbz7q`.
- [x] Existing production Azure target confirmed:
  - Subscription: `MSDN Subscription`
  - Subscription ID: `41fbccc1-bb65-416d-816d-30cb2a41dd9b`
  - Resource group: `mission-journal`
  - Region: `westus2`
- [x] Static Web Apps provider and Key Vault references implemented.
- [x] Sign-in surfaces and remembered-provider behavior implemented.
- [x] Missing-email refusal implemented.
- [x] Privacy and data-deletion instructions implemented.
- [x] Full Functions test suite passed.
- [x] Bicep template compiled.
- [ ] Capture and verify the real Facebook `/.auth/me` principal after the
  controlled deployment.
- [ ] Publish the Meta app after the principal and end-to-end flows pass.
- [x] Public Facebook buttons remain hidden during administrator-only testing.

## 11. All validation checks pass

- [x] 1. Bicep Compilation
- [x] 2. Resource-group Template Validation
- [x] 3. What-If Preview
- [x] 4. Azure Authentication
- [x] 5. Bicep Linting
- [x] 6. Azure Policy Validation
- [x] 7. Application Build and Tests
- [x] 8. Static Role Assignment Verification

### Validation proof

Validated on 2026-09-29 against subscription
`41fbccc1-bb65-416d-816d-30cb2a41dd9b` and resource group
`mission-journal`.

| Check | Command | Result |
|-------|---------|--------|
| Bicep compilation | `az bicep build --file .\infra\main.bicep --stdout` | Passed |
| Template validation | `az deployment group validate --resource-group mission-journal --template-file .\infra\main.bicep --parameters .\infra\main.bicepparam` | `Succeeded` |
| What-if | `az deployment group what-if --resource-group mission-journal --template-file .\infra\main.bicep --parameters .\infra\main.bicepparam --result-format ResourceIdOnly` | Passed: 65 Deploy, 2 Ignore, 1 Unsupported, 0 Create, 0 Delete |
| Authentication | `az account show --subscription 41fbccc1-bb65-416d-816d-30cb2a41dd9b` | Enabled `MSDN Subscription` |
| Bicep lint | `az bicep lint --file .\infra\main.bicep` | Passed; upgrade notice only |
| Policy assignments | `az policy assignment list --disable-scope-strict-match --scope .../resourceGroups/mission-journal` | 0 applicable assignments |
| Application tests | `npm --prefix .\functions test` | 1,894 tests; 1,883 passed, 11 skipped, 0 failed |
| Diff integrity | `git diff --check` | Passed |

The one what-if `Unsupported` resource is
`Microsoft.Web/staticSites/config/appsettings`. The repository deployment
workflow already documents this Azure limitation: what-if cannot inspect
Static Web App app-setting values. Resource-group template validation accepted
the new `FACEBOOK_APP_ID` and Key Vault reference, and the intended deployment
contains no resource creation or deletion.

### Static role assignment verification

- **Static Web App system identity:** `Key Vault Secrets User`, scoped to the
  PdayLetters Key Vault. This is the only new runtime need and already covers
  the versionless `facebook-app-secret` reference.
- **Function App system identity:** Storage Blob Data Contributor at the
  archive account; Storage Blob Data Owner only on Functions host/deployment
  containers; Storage Queue Data Contributor; Storage Table Data Contributor;
  and Key Vault Secrets User. Unchanged by Facebook authentication.
- **Purge user-assigned identity:** custom permanent-deletion role only on the
  six archive containers it purges. Unchanged.
- **Deployment identity:** management roles remain intentionally external to
  the template and constrained as documented in `infra/main.bicep`.

No RBAC additions or broadening are required for Facebook authentication.
