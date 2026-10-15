# Maintenance and periodic tasks

Things that come due on a clock rather than in response to a change, and that therefore have no natural prompt in the [plan](plan.md). Everything here is work the service needs *after* it is built, which is exactly the category that gets forgotten while it is still being built.

The organising principle: **a task nobody is reminded of is a task that fails silently.** Most items below are cheap when scheduled and expensive when discovered, and several of them fail in ways that produce no error at all — a claim email that stops being sent, a domain that stops resolving, a signed-in user who is suddenly signed out. This page is what [Phase 12](plan.md#phase-12--leaving-beta) meant by standing up a maintenance schedule.

---

## Credentials

**Bookmark this section.** Everything that expires is listed here with the steps to renew it. Nothing else in the service needs to be touched on a clock.

### What expires, and when

| Due | Credential | Lives in | Breaks, if it lapses |
|---|---|---|---|
| **2027-08-01** | `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Worker deploys fail — loudly, in CI |
| **2027-08-01** | `INBOX_SAS`, `QUEUE_SAS` | Cloudflare Worker secrets | **All inbound mail, silently.** Every letter becomes an SMTP retry loop, then a bounce |
| **2027-08-31** | `cloudflare-api-token` | Key Vault `mj-kv-utfe5uagkbz7q` | **All outbound mail, silently.** Claim and invite emails simply stop arriving |
| **2028-08-04** | `aad-client-secret` | Key Vault `mj-kv-utfe5uagkbz7q` | Microsoft sign-in, silently — Google keeps working |

Nothing else has a date. `claim-token-key`, `google-client-secret`, `AZURE_STATIC_WEB_APPS_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are covered under [what never rotates](#what-never-rotates).

**⚠️ Two different credentials are called `CLOUDFLARE_API_TOKEN`.** The one in GitHub deploys the Worker; the one in Key Vault sends mail. They are deliberately separate — the deploy token can rewrite the code that receives every inbound letter, and the sending token must never be able to. The shared name means a rotation done by name rather than by location updates the wrong one and appears to work. **Always check which of the two you are holding.**

### How to rotate each one

Every rotation is the same two moves: reissue at the provider, then store in *one* named destination. Reissue first — none of these can be recovered after they are replaced.

#### `cloudflare-api-token` — the mail sender

1. Cloudflare dashboard → **Manage Account** → **API Tokens**. Find the token whose permission is `Email Sending: Edit`.
2. **Roll** it, or create a replacement with the same single permission and a new end date. Copy the value; it is shown once.
3. Store it:
   ```powershell
   az keyvault secret set --vault-name mj-kv-utfe5uagkbz7q `
       --name cloudflare-api-token --value '<token>' `
       --expires '2029-08-01T00:00:00Z' `
       --subscription 41fbccc1-bb65-416d-816d-30cb2a41dd9b
   ```
   Setting `--expires` is what keeps the alert working. A new version without a date is a secret that will never warn again.
4. The Function App reads this through a **versionless** Key Vault reference, so it picks the new value up on its own within 24 hours. Restart to make it immediate:
   ```powershell
   az functionapp restart --name mj-fn-utfe5uagkbz7q --resource-group mission-journal `
       --subscription 41fbccc1-bb65-416d-816d-30cb2a41dd9b
   ```
5. **Prove it works**, because this is the one that fails silently. `functions/tools/send-test-mail.js` sends a real message.

#### `aad-client-secret` — Microsoft sign-in

1. Entra admin center → **App registrations** → the app `3d78e421-0373-4026-be5d-909bc07d455a` → **Certificates & secrets** → **New client secret**. Copy the *Value*, not the Secret ID.
2. Store it with the matching date:
   ```powershell
   az keyvault secret set --vault-name mj-kv-utfe5uagkbz7q `
       --name aad-client-secret --value '<secret>' `
       --expires '2030-08-01T00:00:00Z' `
       --subscription 41fbccc1-bb65-416d-816d-30cb2a41dd9b
   ```
3. The Static Web App reads it at sign-in time, so no restart is needed.
4. **Test by signing in with Microsoft**, in a private window. Google working proves nothing here — the two providers fail independently.
5. Delete the old secret in Entra only after the test passes.

#### `CLOUDFLARE_API_TOKEN` — the Worker deploy token

1. Cloudflare dashboard → **Manage Account** → **API Tokens**. This is the token with `Workers Scripts: Edit` and `Account Settings: Read` — *not* the mail sender.
2. Roll it, then:
   ```powershell
   gh secret set CLOUDFLARE_API_TOKEN --repo kurtzeborn/mission-journal --body '<token>'
   ```
3. **Test by re-running the Worker deploy workflow.** This one fails loudly, so a green run is the whole check.

#### `INBOX_SAS` and `QUEUE_SAS` — the Worker's storage credentials

**The date belongs to the stored access policies, not to the tokens.** `worker-write` on the `inbox` container and `worker-add` on the `ingest` queue are what expire; a token signed against a lapsed policy is lapsed too, so reissuing without touching the policies achieves nothing.

**This is the only rotation with an outage in the middle of it.** Deleting a policy revokes the live token that instant, and the Worker is the front door — do all three steps in one sitting.

1. Delete both policies, which clears the old dates:
   ```powershell
   $key = az storage account keys list --account-name mjstutfe5uagkbz7q `
       --resource-group mission-journal --query '[0].value' --output tsv
   az storage container policy delete --container-name inbox --name worker-write `
       --account-name mjstutfe5uagkbz7q --account-key $key
   az storage queue policy delete --queue-name ingest --name worker-add `
       --account-name mjstutfe5uagkbz7q --account-key $key
   ```
2. Run `infra/mint-worker-sas.ps1`. It recreates both policies a year out and prints the two query strings; it deliberately *reuses* a policy that still exists, which is why step 1 comes first. Store them:
   ```powershell
   npx wrangler secret put INBOX_SAS
   npx wrangler secret put QUEUE_SAS
   ```
3. **Prove it works** by mailing `probe@pdayletters.com` and watching the letter land. Nothing else will tell you: a failed write makes the Worker throw a `4xx`, and the sending server hides that behind retries for hours.

### What never rotates

- **`claim-token-key`** — ours, not a provider's, so nothing forces a date. Rotating it **invalidates every outstanding claim link**, including ones sitting unread in a missionary's inbox with days left on a 60-day window. That makes it a user-visible event, not maintenance. The right cadence is *never, unless compromised*. Recorded here so a future tidying pass does not rotate it for symmetry.
- **`google-client-secret`** — **checked in the Google Cloud console on 2026-08-05: no expiry is set.** Recorded as a checked fact rather than an assumption, because "we checked and there is no date" and "we never checked" look identical in a table. Re-check if the client is ever recreated; Google has been tightening this area.
- **`AZURE_STATIC_WEB_APPS_API_TOKEN`** — no expiry. It changes only if the Static Web App is recreated, in which case read the new one with `az staticwebapp secrets list --name mj-swa-utfe5uagkbz7q`.
- **`CLOUDFLARE_ACCOUNT_ID`** — not a secret, and inert without a token.
- **`pdayletters.com`** — auto-renew is on at Namecheap. See the [annual check](#annually); the risk is the card behind it, not the date.

### Alert coverage

Key Vault raises `SecretNearExpiry` 30 days ahead and `SecretExpired` at expiry; Azure Monitor emails `scott@kurtzeborn.org` without using this service's own mail credentials. It covers only `cloudflare-api-token` and `aad-client-secret`. The GitHub-held deploy token, the Worker's two SAS policies, and the registrar remain calendar items. Key Vault does not renew secrets and does not stop serving an expired value, so every rotation above is still manual.

---

## Recurring checks

### Every deploy that touches Cloudflare Email settings

- **Re-check that email preview is off.** It is the one setting that silently converts a credential into a logged one — claim links travel in message bodies, and a preview stores them.

### Monthly

- **Outbound send volume.** 3,000 messages a month are included, then $0.35/1,000. Sends to verified destinations are free and do not count. A runaway loop is a cost problem before it is a deliverability problem.

### Quarterly

- **`npm audit`.** Run `npm run audit` in `functions/` rather than `npm audit` itself. `tools/audit-check.js` compares advisory **IDs** against `functions/audit-baseline.json` and fails only on ones nobody has looked at yet, so green means *nothing new* rather than *nothing at all*. If it fails, **fix the dependency** when possible. Only when there is nothing safe to move to, add the ID to the baseline **with a note saying why it is unreachable**. An entry without a reason is a silenced alarm.
- **Storage growth.** `inbox/` and `exports/` both expire on their own now — 30 days and 7 days, set by the `lifecycle` policy in `infra/main.bicep`, and the `arrivals` table is swept nightly by the `sweep` timer, which drops counting rows older than 30 days. What is worth a quarterly look is the containers with no rule at all: `raw/` and `rendered/` grow for as long as the archives live, which is the intended behavior and the reason the bill will only ever go up.
  - **The `nudges` table is deliberately not swept.** Most of its rows are once-ever gates — deleting one re-sends a message somebody already got — and only the `ack:` rows are dated. They accumulate one row per forwarder per archive per day, which is small enough that the risk of a sweep touching the wrong prefix is the larger number.

### Annually

- **Domain renewal** — auto-renew is on at Namecheap, so the annual check is that it is *still* on, and that the card behind it has not expired. Auto-renew failing for want of a payment method is the failure this check exists for; the renewal date itself is not the risk.
- **Confirm blob soft delete is still 30 days**, container delete retention 30 days, versioning on, `allowPermanentDelete` true.
- **Review who has access** — the ACLs, the Azure RBAC assignments on the storage account and vault, and the Cloudflare account.
