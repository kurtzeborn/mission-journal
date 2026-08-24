# Maintenance and periodic tasks

Things that come due on a clock rather than in response to a change, and that therefore have no natural prompt in the [plan](plan.md). Everything here is work the service needs *after* it is built, which is exactly the category that gets forgotten while it is still being built.

The organising principle: **a task nobody is reminded of is a task that fails silently.** Most items below are cheap when scheduled and expensive when discovered, and several of them fail in ways that produce no error at all — a claim email that stops being sent, a domain that stops resolving, a signed-in user who is suddenly signed out. Standing this up properly is the last item before [leaving beta](plan.md#phase-12--leaving-beta).

---

## Credentials

**Bookmark this section.** Everything that expires is listed here with the steps to renew it. Nothing else in the service needs to be touched on a clock.

### What expires, and when

| Due | Credential | Lives in | Breaks, if it lapses |
|---|---|---|---|
| **2027-08-01** | `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Worker deploys fail — loudly, in CI |
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

### What never rotates

- **`claim-token-key`** — ours, not a provider's, so nothing forces a date. Rotating it **invalidates every outstanding claim link**, including ones sitting unread in a missionary's inbox with days left on a 60-day window. That makes it a user-visible event, not maintenance. The right cadence is *never, unless compromised*. Recorded here so a future tidying pass does not rotate it for symmetry.
- **`google-client-secret`** — **checked in the Google Cloud console on 2026-08-05: no expiry is set.** Recorded as a checked fact rather than an assumption, because "we checked and there is no date" and "we never checked" look identical in a table. Re-check if the client is ever recreated; Google has been tightening this area.
- **`AZURE_STATIC_WEB_APPS_API_TOKEN`** — no expiry. It changes only if the Static Web App is recreated, in which case read the new one with `az staticwebapp secrets list --name mj-swa-utfe5uagkbz7q`.
- **`CLOUDFLARE_ACCOUNT_ID`** — not a secret, and inert without a token.
- **`pdayletters.com`** — auto-renew is on at Namecheap. See the [annual check](#annually); the risk is the card behind it, not the date.

### The alert that reminds you

**Shipped 2026-08-11.** Key Vault raises `SecretNearExpiry` 30 days ahead; an Event Grid system topic on the vault routes that and `SecretExpired` to a `MonitorAlert` at Sev2, which mails `scott@kurtzeborn.org`. All of it is in `infra/main.bicep`, gated on the `alertEmail` parameter.

**It only covers the two Key Vault secrets.** The GitHub-held deploy token is invisible to it — that one needs the calendar entry.

**The notification deliberately does not go through our own mailer.** Every message this service sends uses `cloudflare-api-token`, one of the secrets being watched. An alert about that token expiring, sent with that token, would fail exactly when it mattered. Azure Monitor's email path shares nothing with the system it reports on.

Three things worth remembering about the mechanism:

- **`MonitorAlert` needs `eventDeliverySchema: 'CloudEventSchemaV1_0'`,** which is not the default. Without it the deployment fails naming the schema but not the resource that wanted it. `Microsoft.EventGrid` must also be registered on the subscription first.
- **`az eventgrid system-topic event-subscription show` cannot read this subscription** — the CLI pins an API version older than the feature. Verify with `az resource show --api-version 2025-02-15` instead.
- **`SecretNewVersionCreated` is deliberately not subscribed.** The vault emits it on every write, so a rotation — the fix — would raise an alert of its own.

**Key Vault cannot renew any of this,** and serves an expired secret quite happily. Auto-renewal is certificates-only for integrated CAs, and `exp` is advisory rather than enforced on read. So the date is a warning that can never cause an outage of its own, and every rotation above is done by hand.

### The alignment goal

**Tracked in [issue #7](https://github.com/kurtzeborn/mission-journal/issues/7).** The rotation steps above are the reference; the issue holds the decision and the date.

**The notification deliberately does not go through our own mailer.** Every message this service sends uses `cloudflare-api-token` — one of the secrets being watched. An alert about that token expiring, sent with that token, would fail exactly when it mattered. Azure Monitor's email path shares nothing with the system it reports on.

Three things worth remembering about the mechanism:

- **`MonitorAlert` needs `eventDeliverySchema: 'CloudEventSchemaV1_0'`,** which is not the default. Without it the deployment fails naming the schema but not the resource that wanted it. `Microsoft.EventGrid` must also be registered on the subscription first.
- **`az eventgrid system-topic event-subscription show` cannot read this subscription** — the CLI pins an API version older than the feature and refuses. Verify with `az resource show --api-version 2025-02-15` instead.
- **`SecretNewVersionCreated` is deliberately not subscribed.** The vault emits it on every write, so including it would make a rotation — the fix — raise an alert of its own.

### What is still not covered

**Key Vault cannot renew any of these.** Auto-renewal is a certificates-only feature for integrated CAs, so the alert is the entire mechanism — every rotation below is done by hand. Real automation would be a Function reacting to the near-expiry event and calling Graph or the Cloudflare API, which is justifiable across a set and hard to justify for one secret every two years.

**Key Vault also serves an expired secret quite happily.** `exp` is advisory for secrets and is not enforced on read, so a date set early is a warning rather than a scheduled outage — which is what makes it safe to set these honestly.

Three of the credentials in the table live outside Key Vault, so none of this sees them: both GitHub Actions secrets and the registrar. Because `exp` is advisory, a secret holding nothing but a note could carry the GitHub deploy token's real date and surface in the same alert. That is a trick rather than a design, and it earns its place only if the alternative is a calendar entry nobody shares — revisit it during the [alignment pass](#the-alignment-goal), when the whole set is being handled at once anyway.

---

## Recurring checks

### Every deploy that touches Cloudflare Email settings

- **Re-check that email preview is off.** Verified off 2026-08-04 and again 2026-08-05. It is the one setting that silently converts a credential into a logged one — claim links travel in message bodies, and a preview stores them.

### Monthly

- **Outbound send volume.** 3,000 messages a month are included, then $0.35/1,000. Sends to verified destinations are free and do not count. A runaway loop is a cost problem before it is a deliverability problem.
- **DMARC aggregate reports** for `pdayletters.com`. **Moved to `p=quarantine; pct=100; ri=604800` on 2026-08-23**, after the reports through August showed a single source — Cloudflare — signing and passing on every message. `ri` asks for weekly aggregates rather than daily; it is advisory, so some providers will keep sending daily anyway.

  **`p=reject` is the remaining step, and the evidence for it is the forwarding case.** A Comcast report on 2026-08-23 recorded one of our letters forwarded by somebody's Gmail: the envelope was then `gmail.com`, so SPF no longer aligned and was scored a fail, and only the surviving `pdayletters.com` DKIM signature carried it through. Under `reject` that difference is a grandparent's forward arriving or vanishing without trace. So the thing to look for each month is not *are there failures* — forwards will always show an SPF fail — but **is DKIM passing on every record**. A run of clean months earns `reject`; a single DKIM failure from a forward does not.

  **The Cloudflare Email Sending settings page misreports the policy** — it claimed `p=reject` while DNS said `p=none`. Read DNS, never that page.

  **2026-08-24 — the first batch after the change was clean.** Five records across four receivers (Microsoft Enterprise, Outlook.com, Google, Yahoo): DKIM pass, SPF pass, disposition `none`, every source IP Cloudflare's. Every record carried both Cloudflare's own third-party signature and the aligned `pdayletters.com` one, selector `cf-bounce`. All four still report `policy_published: p=none`, because their windows are 22–23 August and the change landed on the 23rd — expected, not a regression. **No forwarded mail in the batch at all**, so it is no evidence either way for `p=reject`; that step still waits on months whose forwards keep DKIM.

  **Reports are moving to [Cloudflare DMARC Management](https://developers.cloudflare.com/dmarc-management/)** — free, dashboard rather than inbox, and it keeps the evidence trail that `p=reject` has to be earned on, which deleting `rua=` would throw away. **Enabled 2026-08-24.** Its "Fix record" button appended its own address and left everything else alone; the record now reads `v=DMARC1; p=quarantine; pct=100; rua=mailto:<id>@dmarc-reports.cloudflare.net,mailto:dmarc@pdayletters.com; ri=604800`, and SPF is untouched at `v=spf1 include:_spf.mx.cloudflare.net ~all`. **Remaining step: once reports are actually appearing in the dashboard, drop `mailto:dmarc@pdayletters.com` from the `rua=` list** — that is what stops the mail. Two cautions for next time: DMARC Management also wants to manage the **SPF** record and cannot do that safely when a CNAME in the zone points at an external domain, so let it touch DMARC only; and per the paragraph above, verify from DNS rather than from the panel.

### Quarterly

- **`npm audit`.** Permanently red on `mailauth`'s transitive advisories, which were [measured as unreachable](plan.md#phase-8--outbound-mail-and-preferences). That is the hazard: a permanently red audit is one a real advisory gets scrolled past in. Either add an allowlist so the output means something again, or accept that this check requires reading rather than glancing.
- **Storage growth.** `inbox/` and `exports/` both expire on their own now — 30 days and 7 days, set by the `lifecycle` policy in `infra/main.bicep`, and the `arrivals` table is swept nightly by the `sweep` timer, which drops counting rows older than 30 days. What is worth a quarterly look is the containers with no rule at all: `raw/` and `rendered/` grow for as long as the archives live, which is the intended behavior and the reason the bill will only ever go up.
  - **The `nudges` table is deliberately not swept.** Most of its rows are once-ever gates — deleting one re-sends a message somebody already got — and only the `ack:` rows are dated. They accumulate one row per forwarder per archive per day, which is small enough that the risk of a sweep touching the wrong prefix is the larger number.

### Annually

- **Domain renewal** — auto-renew is on at Namecheap, so the annual check is that it is *still* on, and that the card behind it has not expired. Auto-renew failing for want of a payment method is the failure this check exists for; the renewal date itself is not the risk.
- **Confirm blob soft delete is still 30 days**, container delete retention 30 days, versioning on, `allowPermanentDelete` true.
- **Review who has access** — the ACLs, the Azure RBAC assignments on the storage account and vault, and the Cloudflare account.
