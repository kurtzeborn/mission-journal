# Maintenance and periodic tasks

Things that come due on a clock rather than in response to a change, and that therefore have no natural prompt in the [plan](plan.md). Everything here is work the service needs *after* it is built, which is exactly the category that gets forgotten while it is still being built.

The organising principle: **a task nobody is reminded of is a task that fails silently.** Most items below are cheap when scheduled and expensive when discovered, and several of them fail in ways that produce no error at all — a claim email that stops being sent, a domain that stops resolving, a signed-in user who is suddenly signed out. Standing this up properly is the last item before [leaving beta](plan.md#phase-12--leaving-beta).

---

## Credentials

### Inventory

| Credential | Where the value lives | Where it is used | Expires |
|---|---|---|---|
| `aad-client-secret` | Key Vault `mj-kv-utfe5uagkbz7q` | Microsoft sign-in (Entra app registration) | **2028-08-04** |
| `cloudflare-api-token` | Key Vault `mj-kv-utfe5uagkbz7q` | Function App outbound mail (`Email Sending: Edit`) | **2027-08-31** |
| `claim-token-key` | Key Vault `mj-kv-utfe5uagkbz7q` | HMAC for claim links | *none* — see below |
| `google-client-secret` | Key Vault `mj-kv-utfe5uagkbz7q` | Google sign-in | *none* — checked 2026-08-05, see below |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Worker deploy (`Workers Scripts`, `Account Settings`) | **2027-08-01** |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Worker deploy | not a secret, does not expire |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | GitHub Actions secret | Static Web App deploy | no expiry; rotates if the SWA is recreated |
| `pdayletters.com` | Registrar (Namecheap) | Everything | **auto-renew on** — no date to track |

**⚠️ Two different credentials are called `CLOUDFLARE_API_TOKEN`.** The one in GitHub deploys the Worker; the one in Key Vault sends mail. They are deliberately separate — the deploy token can rewrite the code that receives every inbound letter, and the sending token must never be able to — but the shared name means a rotation done by name rather than by location will update the wrong one and appear to work. Rotating either is a two-place operation: reissue in Cloudflare, then store in *one* named destination.

### The alignment goal

**Before leaving beta, every credential should expire in the same month, so they roll in one sitting.** Left alone, each one expires on whatever date it happened to be created, and rotation becomes a task that arrives unannounced several times a year and is done under time pressure every time.

**They are already nearly aligned, by accident: August.** `2027-08-01`, `2027-08-31`, `2028-08-04`. Nothing has to be moved far — the work is to make it deliberate, pick a date (early August, so the deadline is not the same week as the reminder), and pull the outliers back. Cloudflare tokens can be reissued with any end date, and an Entra secret can be created short and replaced early, so this costs one afternoon.

**Two secrets have no expiry at all, and that is a decision, not an oversight — but it should be a recorded one:**

- **`claim-token-key`** is ours, not a provider's, so nothing forces a date. Rotating it **invalidates every outstanding claim link**, including ones sitting unread in a missionary's inbox with days left on a 60-day window. That makes rotation a user-visible event rather than a maintenance task, and the right cadence is *never, unless compromised*. Worth writing down so a future tidying pass does not rotate it for symmetry.
- **`google-client-secret`** — **checked in the Google Cloud console on 2026-08-05: no expiry is set.** Google OAuth client secrets historically did not expire, and this one was not issued with a date. Recorded as a checked fact rather than an assumption, because "we checked and there is no date" and "we never checked" look identical in a table. Worth re-checking if the client is ever recreated, since Google has been tightening this area.

### Automating the reminder

**Shipped 2026-08-11.** The vault is the one place that knows when anything expires, and it now says so out loud.

- **Event Grid system topic `mj-evt-utfe5uagkbz7q`** on the Key Vault, subscribing to `Microsoft.KeyVault.SecretNearExpiry` and `Microsoft.KeyVault.SecretExpired` only.
- **Destination is `MonitorAlert`, Sev2**, firing action group `mj-ag-utfe5uagkbz7q`, which mails `scott@kurtzeborn.org`. Delivery confirmed with `az monitor action-group test-notifications create`.
- **All of it is in `infra/main.bicep`**, gated on the `alertEmail` parameter — empty creates none of it, which is the right default for a scratch deployment.

The alert arrives **30 days ahead**, names the vault and the secret, and points here. The table above is what turns that into an action: it says what the credential does and where it is reissued, which the event does not.

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
- **DMARC aggregate reports** for `pdayletters.com`. The policy is `p=none` with `rua=` reporting; the point of `none` is to gather evidence before tightening. **Moving to `p=quarantine` and then `p=reject` is an outstanding task, not a permanent state** — and note that the Cloudflare Email Sending settings page *misreports* the policy as `p=reject` already. Read DNS, never that page.

### Quarterly

- **`npm audit`.** Permanently red on `mailauth`'s transitive advisories, which were [measured as unreachable](plan.md#phase-8--outbound-mail-and-preferences). That is the hazard: a permanently red audit is one a real advisory gets scrolled past in. Either add an allowlist so the output means something again, or accept that this check requires reading rather than glancing.
- **Storage growth**, particularly `exports/`, which accumulates and has no lifecycle rule yet.

### Annually

- **Domain renewal** — auto-renew is on at Namecheap, so the annual check is that it is *still* on, and that the card behind it has not expired. Auto-renew failing for want of a payment method is the failure this check exists for; the renewal date itself is not the risk.
- **Confirm blob soft delete is still 30 days**, container delete retention 30 days, versioning on, `allowPermanentDelete` true.
- **Review who has access** — the ACLs, the Azure RBAC assignments on the storage account and vault, and the Cloudflare account.
