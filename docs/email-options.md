# Email Provider Options and Pricing

This document compares the realistic options for the Mission Journal service's email needs, projects monthly cost across four growth scenarios, and gives a recommendation for each stage.

Prices listed here reflect publicly advertised pricing as of mid-2026. Providers change pricing regularly; verify at signup and don't lock in on numbers here.

**SendGrid's published pricing is currently hard to read.** Twilio has consolidated the SendGrid site into twilio.com and the plan table renders client-side, so the tiers below could not be re-verified from the public page. Treat them as indicative and confirm in the account console. This does not block Phase 0 — see [Bottom line](#bottom-line).

## Requirements recap

- **Inbound**: receive mail at **two fixed shared addresses**, `post@` and `claim@`, with **MX on the apex** of each owned domain. There are no tokenized or per-missionary addresses — routing derives the missionary from the letter's *author*, never from the recipient — so the provider only needs plain MX-plus-webhook delivery of parsed MIME. Messages are classified as `direct` (from `@missionary.org`) or `forward` (forwarded by an ACL member). See [plan.md](plan.md).
- **Outbound**: send acknowledgments, digests, forwards, notifications, and unsubscribe-link emails. Deliverability into personal Gmail / Outlook.com / Yahoo inboxes matters.
- **Attachment sizes**: missionary photos average 3–5 MB, worst case 20 MB per email (batches of high-res photos). Provider caps and per-MB pricing matter.
- **Custom domain**: DKIM/SPF/DMARC authentication with the service's own domain.

## Volume assumptions per scenario

| Scenario | Missionaries | Inbound / month | Outbound / month | Avg. email size | Notes |
|---|---|---|---|---|---|
| **Initial** | 1 (owner testing) | 20 | 50 | 4 MB | Dev + smoke test. Weekly missionary emails + a handful of historical forwards. Outbound is mostly dedupe acks. |
| **Low traffic** | 10 | 200 | 1,000 | 4 MB | First public year. Weekly missionary emails + occasional historical forwards. Outbound = ~2 digest recipients × 4 weeks × 10 missionaries + ack replies. |
| **Growth** | 100 | 2,000 | 15,000 | 4 MB | Steady state after growth. 20 subscribers per missionary + acks + weekly digests. |
| **Scale** | 1,000 | 20,000 | 150,000 | 4 MB | Aspirational scale. Same per-missionary profile at 10× volume. |

## Provider comparison

### SendGrid (Twilio)

- **Inbound Parse**: unlimited, free, on every plan (including free tier). MX-based, webhook delivery of parsed MIME.
- **Outbound tiers**:
  - Free: 100 emails/day (~3,000/mo)
  - Essentials 50K: ~$20/mo (50,000 emails/mo)
  - Essentials 100K: ~$35/mo
  - Pro 100K: ~$90/mo (dedicated IP, subuser accounts)
  - Pro 300K: ~$300/mo
- **Attachment limit**: 30 MB per outbound message; Inbound Parse handles up to 30 MB inbound.
- **Deliverability**: Industry-leading. Shared IP pool for Free/Essentials; dedicated IPs on Pro+.
- **Custom domain**: standard "Sender Authentication" via CNAME records (DKIM + branded return-path). Free.

### Cloudflare Email Service (Email Routing + Email Workers)

Verified against Cloudflare's docs, August 2026. **This is no longer routing-only** — Cloudflare added outbound sending, so it is now one of only three shortlisted options that does both directions.

- **Inbound**: **unlimited and free on every plan**, including Workers Free. MX-based. Instead of a webhook, an inbound message invokes a Worker's `email()` handler with the envelope sender, recipient, headers, and `raw` as a `ReadableStream`.
- **Outbound**: requires **Workers Paid ($5/mo)**. 3,000 emails included per month, then **$0.35 per 1,000**. Sends to verified destination addresses in your own account are free and don't count against quota. Daily limits start conservative for new accounts and scale with sending reputation.
- **Message size**: **25 MiB inbound** (larger is rejected at SMTP). Outbound is **5 MiB** including attachments — irrelevant here, since our outbound is text plus at most one thumbnail.
- **Recipients**: 50 per message. We send one message per person, so this never binds.
- **`message.reply()`** builds a threaded reply that passes through the same SMTP session and preserves the `Message-ID` chain. Its constraints line up almost exactly with the reply design in [plan.md](plan.md): the outgoing sender domain must match the domain that received the mail, and the recipient must match the incoming sender. **It requires the incoming message to pass DMARC**, which our `direct` and `claim@` traffic does by definition but a relative forwarding from an old ISP account may not.
- **`message.setReject(reason)`** returns a real SMTP error to the sending server. See [Durability](#durability-is-the-axis-cloudflare-wins) below — this is the most interesting property on offer.
- **Requires the domain's nameservers to be on Cloudflare.** All four domains are currently on Namecheap, so this is a migration, not a config change.
- **Workers Free CPU limits apply to email handlers**; Cloudflare explicitly warns that complex handlers fail with `EXCEEDED_CPU`. Streaming a 25 MiB message would want the Paid plan anyway — which is the same $5 outbound needs.

### Azure Communication Services (ACS) Email

> **ACS Email is send-only. It cannot receive mail** — verified against Microsoft Learn, August 2026. There is no MX-based inbound path and no received-message event; the only Event Grid events ACS emits are `EmailDeliveryReportReceived` and `EmailEngagementTrackingReportReceived`, which report on mail *we sent*. Choosing ACS therefore means running a second provider for inbound, which is a split (see [Split vs. single-provider](#split-vs-single-provider)).

- **Pricing**: pay-per-use, no monthly base. Send: $0.00025 per email + $0.00012 per MB of message size (headers + body + attachments).
- **Attachment limit**: 30 MB per message.
- **Deliverability**: shared Azure sender pool; can request dedicated pool for a fee at scale.
- **Custom domain**: verified custom domain via DNS TXT records; DKIM/SPF managed automatically. Free.
- **Integration**: managed identity for send calls, so no API key to rotate or store in Key Vault. This is the genuine advantage and it applies to outbound only.

### Postmark

- **Pricing** (at 10K messages/mo): Free $0 (100/mo), Basic $15, Pro $16.50, Platform $18. The pricing page asks how many emails you "send **and receive**," so inbound consumes quota.
- **Inbound is not on every tier.** Free, Pro, and Platform include Inbound Email; **Basic does not**. The cheapest usable inbound tier is therefore **Pro at $16.50/mo**, not the $15 headline.
- **Inbound size**: cumulative attachments may not exceed **35 MB** — the most generous of the six.
- **Failure handling**: 10 retries over roughly 10 hours (1 min → 6 hrs), then the message is marked *Inbound Error*. It is **retained and replayable** via `PUT /messages/inbound/{id}/retry` for the retention period, 45 days by default.
- **⚠️ No webhook signature verification.** Postmark's docs state plainly that HMAC signing is not supported; the recommended model is **HTTP Basic Auth credentials embedded in the webhook URL**, combined with allowlisting their published inbound IPs. A password in a URL is materially weaker than a signature, and SWA IP restrictions are Standard-only and site-wide. This is the strongest argument against Postmark for inbound here.
- **Domains**: up to 10 on Pro.
- **Deliverability**: still regarded as the best in the industry for transactional mail.

### Mailgun (Sinch)

- **Pricing**: Free $0 (100/day), Basic from $15/mo (10K), Foundation $35/mo (50K), Scale $90/mo (100K).
- **Inbound routes are tiered**: Free gets **1 route**, Basic gets **5**, and only Foundation and above get "full access to inbound routing." Worse, **custom sending domains are capped at 1 on both Free and Basic** — four domains requires **Foundation at $35/mo**.
- **Inbound size**: **unpublished.** No maximum inbound message size appears anywhere in Mailgun's docs or help center. For a design whose entire risk is 20 MB photo batches, an undocumented limit is worse than a low documented one.
- **Failure handling**: retries for a total of 8 hours; 406 stops retries immediately. **What happens after exhaustion is undocumented.** The `store()` action retains messages, but the retention figure conflicts across their own sources — 3 days in the docs, "up to 7 days depending on plan" in the help center, and 1 day on Foundation per the pricing page.
- **Signature verification**: yes, HMAC-SHA256 over `timestamp + token`, plus optional TLS client certificates.

### Resend

The most interesting of the alternatives, because its inbound design solves a problem the others don't.

- **Pricing**: Free $0 (3,000/mo, 100/day, **1 domain**), Pro $20/mo (50,000/mo, 10 domains, no daily cap). Inbound is included on every plan including Free.
- **⚠️ Inbound consumes the same quota as outbound — VERIFIED.** *"Both sent emails and received emails (inbound) count towards your account's email quota. Each received email counts as 1 email against your daily and monthly limits, just like sent emails."* ([account quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)) So Free is 100/day and 3,000/mo **across both directions combined**. A ~100-letter historical backfill lands exactly on the daily cap, and from Phase 8 every ack and digest reduces headroom for receiving. Pro removes the daily limit.
- **What happens to inbound at the cap is undocumented.** `daily_quota_exceeded` is a `429` on the API; whether an over-cap inbound message gets a 4xx at SMTP (harmless) or is dropped is stated nowhere. Open question in the plan.
- **The webhook carries metadata only** — no body, no headers, no attachments. You fetch content afterward from the Received Emails and Attachments APIs. Resend states this is deliberate: *"This design choice supports large attachments in serverless environments that have limited request body sizes."* **That sidesteps the 30 MB SWA request ceiling entirely**, which no other webhook-based provider here does.
- **Raw MIME is retrievable.** `GET /emails/receiving/{id}` returns a `raw` object with a signed `download_url` (expires ~1 hour) containing the original message including attachments — so byte-exact archival and independent DKIM re-verification both remain possible.
- **Retries are idempotent for free.** The `email_id` is server-assigned and stable across retries, so naming the blob after it means a retry overwrites rather than duplicates.
- **Failure handling**: *"Resend stores emails as soon as they come in"*, so a dead webhook loses nothing. Retries on a published schedule, plus manual replay from the dashboard. Content retention is 30 days — ample, since we copy to Blob within seconds.
- **Signature verification**: yes, via Svix (`svix-id`, `svix-timestamp`, `svix-signature`).
- **Catch-all only**: any address at the domain is accepted and forwarded; you filter on `to` yourself. That matches our design, which already ignores everything but two known local-parts.
- **Maximum inbound message size is unpublished** — the same gap that counts against Mailgun.

### CloudMailin

An inbound specialist, and the best conceptual fit of the six — priced out of contention.

- **Pricing is tiered on message size**, which is exactly the wrong axis for us: Free 512 KB, Starter $25/mo 2 MB, Professional $45/mo 10 MB, **Premium $85/mo 50 MB**. A 20 MB photo batch means Premium. Every cheaper tier rejects our worst case outright.
- **All paid plans write attachments directly to S3, Azure Blob, or GCS** — natively the thing we would otherwise hand-roll. At $85/mo it doesn't matter, but it is the single most elegant fit on offer.
- Custom domains and catch-all receiving on all paid plans.

### MailerSend

- **Pricing**:
  - Free: 3,000/mo outbound + 300/mo inbound
  - Hobby: $28/mo for 50K + inbound routes included
  - Starter: $80/mo for 100K
- **Attachment limit**: 25 MB.
- **Deliverability**: solid but younger vendor with less reputation history than SendGrid or Postmark.

### Amazon SES

- **Pricing**:
  - Send: $0.10 per 1,000 emails
  - Receive: $0.10 per 1,000 emails + $0.09/GB attachment
  - Outbound bandwidth: $0.12/GB after 100 GB free
  - Free tier: 3,000/mo, **only from EC2** (not applicable to Azure-hosted services).
- **Attachment limit**: 40 MB.
- **Deliverability**: excellent once sender reputation is built; cold-start reputation is worse than SendGrid or Postmark.
- **Trade-off**: adds AWS to an otherwise all-Azure stack. Cross-cloud IAM, extra CLI, extra billing surface.

### M365 shared mailbox + Microsoft Graph sendMail

- **Pricing**: $0 marginal cost (assumes existing tenant).
- **Inbound**: free — Graph change notifications on a shared mailbox trigger a Function. Attachments retrieved via Graph API.
- **Outbound**:
  - Uses tenant's daily send quota (typically 10,000 recipients/day, subject to abuse-detection throttling).
  - Rate-limited to ~30 messages/minute per account.
  - **Not really transactional-grade** — no per-message tracking, no bounce webhooks, no automatic reputation management, and Microsoft actively throttles bulk-looking traffic from tenants.
- **Attachment limit**: 150 MB per message (but 25 MB is the practical delivery ceiling for the receiving side).
- **Deliverability**: routed through Exchange Online; fine for tenant-to-consumer at low volume, degrades badly under load.

## Inbound handling, head to head

Inbound is the deciding axis. Outbound is a solved commodity and a Phase 8 decision; inbound is where a letter can be lost forever, and the six candidates differ enormously.

| | Cost (1 domain) | Inbound quota | Max inbound size | If our endpoint is down | Webhook auth |
|---|---|---|---|---|---|
| **Cloudflare** | **$0** | **unlimited, no daily cap** | 25 MiB | **Sender's own MTA retries for days** — nothing is ever accepted then lost | N/A — no public endpoint exists |
| **Resend** | $0 → $20/mo | ⚠️ **100/day, 3,000/mo, shared with outbound** | not published | Stored on arrival; retries + manual replay; 30-day window | Svix signature |
| **Postmark** | $0 (100/mo) → $16.50/mo | 100/mo free; Basic **excludes inbound** | **35 MB** | Stored; 10 retries over ~10 hrs; replayable 45 days | ⚠️ **none** — Basic Auth in the URL + IP allowlist |
| **Mailgun** | $0 (1 route) → $15/mo | 100/day free | **unpublished** | 8 hrs of retries; **post-exhaustion behavior undocumented** | HMAC-SHA256 |
| **SendGrid** | $0 | unmetered | 30 MB | ⚠️ **permanently discarded** | signed webhooks (opt-in) |
| **CloudMailin** | **$85/mo** | 10,000/mo | 50 MB (at that price) | — | — |

Dropping from four domains to one changed this table materially — it removed the per-domain surcharges that had been doing most of the work, and left the comparison to turn on quota, size limits, and failure behavior instead.

**CloudMailin is priced on the one axis that hurts us.** It bills by maximum message size, and our worst case is a 20 MB photo batch, so the first tier that accepts our mail at all is Premium at $85/mo. That's genuinely a shame — it's the only provider here that writes attachments straight into Azure Blob Storage as a built-in feature, which is precisely the thing we'd otherwise write ourselves.

**Mailgun is the weakest credible option**, which is not where its reputation would put it. At one domain it's free, so cost no longer rules it out — but its maximum inbound message size is published nowhere, and its own documentation disagrees with its own pricing page about how long `store()` retains a message. For a system whose failure mode is "the only surviving copy of a letter," undocumented limits are disqualifying on their own.

**Postmark is disqualified by tier structure, not quality.** It is the best-regarded sender here and has the most generous documented inbound size limit, but its Free tier is 100 messages/month total and its $15 Basic tier **excludes inbound entirely**, so the cheapest usable plan is Pro at $16.50/mo. It also has no HMAC webhook signing, only Basic Auth credentials embedded in the URL.

**The choice came down to Cloudflare vs. Resend, and it was genuinely close.** Resend wins on everything downstream of ingest — one runtime instead of two, one telemetry system instead of two, managed identity instead of a long-lived SAS exported to a third party, and idempotent retries for free, since its server-assigned `email_id` makes a retry overwrite rather than duplicate. **Its metadata-only webhook is a genuinely better design**: it is the only one here that doesn't have to squeeze a whole message through the 30 MB Static Web Apps request ceiling.

**It lost on the quota, and specifically on what happens at the quota.** Free is 100/day and 3,000/month spanning both directions. That alone would be survivable — you could spread a backfill over two days, or pay $20 for one month. What isn't survivable is that **Resend documents no behavior for inbound mail arriving over the cap**. If it returns a 4xx at SMTP, nothing is lost and the sender retries; if it accepts and drops, letters disappear silently. Nobody says which.

**Bulk-forwarding an entire mission's back catalogue in one sitting is an explicitly supported scenario** — roughly 100 messages, landing exactly on the limit, performed once, with mail that by definition cannot be re-sent. Taking an undocumented failure mode on precisely that operation is not a trade worth making for $0, and paying $20/mo to avoid it costs four times Cloudflare's outbound tier. Cloudflare's inbound is unlimited, uncapped, free, and fails as an SMTP error the sending server retries for days.

## Durability is the axis Cloudflare wins

The inbound design in [plan.md](plan.md) is shaped around a specific SendGrid weakness. The intake Function does exactly two things — store the raw body, enqueue the ID — and returns 200, *because SendGrid permanently discards a message once its webhook retries are exhausted*. Every ounce of complexity in that Function is a chance to lose a letter forever.

An Email Worker changes that failure mode at the root. The handler runs **inside the SMTP transaction**, so a failure returns a temporary error to the *sending* mail server, which then retries on its own schedule for days. Gmail, Exchange Online, and Proofpoint all do this correctly. There is no window in which a letter is accepted and then quietly dropped.

For a service whose central promise is that these letters are preserved permanently and are, for many families, the only surviving copy, losing one is the worst failure available. That makes this a real argument and not a technicality.

**It also removes an unauthenticated public endpoint.** A webhook is a URL that anyone who discovers it can POST arbitrary bytes to, and ours would write those bytes to Blob Storage and enqueue work. Signature verification mitigates that and any webhook provider would require it — but an Email Worker has no public HTTP surface at all, so the problem does not exist rather than being managed.

**The counterweight is a credential outside Azure.** The Worker needs a storage SAS, which means a long-lived secret living in a third party's edge platform — the one place this design can't use managed identity. Scope it as if it will leak: write-only to `raw/_inbox/`, add-only to the ingest queue, no read on `rendered/`, no delete anywhere.

**And deliverability, for outbound only.** Cloudflare's sending product is young and has no reputation history comparable to Postmark's. The single hardest delivery in this system is a short message containing a claim link, addressed to a Gmail inbox on `missionary.org`, behind Proofpoint — which is the exact shape of a phishing email. That is the worst possible place to bet on an unproven sender, and it is the strongest argument for splitting outbound to a specialist at Phase 8.

**The counterweight is deliverability.** Cloudflare's sending product is young and has no reputation history comparable to SendGrid's or Postmark's. The single hardest delivery in this system is a short message containing a claim link, addressed to a Gmail inbox on `missionary.org`, behind Proofpoint — which is the exact shape of a phishing email. That is the worst possible place to bet on an unproven sender, and it is the strongest argument for keeping outbound where the reputation already is.

## Cost projections per scenario

Costs shown are **monthly**, in USD, and rounded. Assumes 4 MB average message size where per-MB pricing applies.

### Initial (1 missionary, 20 inbound / 50 outbound per month)

| Provider | Inbound cost | Outbound cost | **Total / month** | Notes |
|---|---:|---:|---:|---|
| SendGrid | $0 (free) | $0 (free tier) | **$0** | Trivially covered by free tier |
| ACS Email | **cannot receive** | ~$0.03 | **—** | Send-only; needs a second provider for inbound |
| Cloudflare | $0 (unlimited) | included | **$5** | Workers Paid is required for any outbound at all |
| Postmark | (included) | $15 | **$15** | No free tier |
| Mailgun | (included) | $15 | **$15** | No free tier |
| MailerSend | $0 (free) | $0 (free tier) | **$0** | Free tier fits |
| Amazon SES | ~$0.01 | ~$0.01 | **~$0.02** | Cheapest in raw cost |
| M365 + Graph | $0 | $0 | **$0** | Uses existing tenant |

### Low traffic (10 missionaries, 200 inbound / 1,000 outbound per month)

| Provider | Inbound | Outbound | **Total** | Notes |
|---|---:|---:|---:|---|
| SendGrid | $0 | $0 | **$0** | 1,000/mo is 33/day, well under the 100/day free ceiling |
| ACS Email | **cannot receive** | ~$0.75 | **—** | Send-only; needs a second provider for inbound |
| Cloudflare | $0 (unlimited) | included | **$5** | 1,000/mo sits inside the 3,000 included |
| Postmark | (included) | $15 | **$15** | Minimum plan |
| Mailgun | (included) | $15 | **$15** | Minimum plan |
| MailerSend | $0 | $0 | **$0** | 1K/mo fits free tier |
| Amazon SES | ~$0.02 | ~$0.10 | **~$0.12** | Absurdly cheap |
| M365 + Graph | $0 | $0 | **$0** | Within tenant quotas |

### Growth (100 missionaries, 2,000 inbound / 15,000 outbound per month)

| Provider | Inbound | Outbound | **Total** | Notes |
|---|---:|---:|---:|---|
| SendGrid | $0 | $0 | **$0** | 15K/mo is 500/day, still under 100/day only if we can burst — in practice we'd exceed on peak days. **Realistic:** move to Essentials ~$20/mo |
| SendGrid Essentials 50K | $0 | ~$20 | **~$20** | Comfortable headroom |
| ACS Email (send) + SendGrid (receive) | $0 | ~$11 | **~$11** | Only viable as a split — ACS cannot receive |
| Cloudflare | $0 (unlimited) | ~$4 | **~$9** | $5 base + 12,000 over the included 3,000 |
| Postmark | (included) | $50 | **$50** | 50K tier |
| Mailgun Foundation | (included) | $35 | **$35** | 50K tier |
| MailerSend Hobby | (included) | $28 | **$28** | 50K tier |
| Amazon SES | ~$0.20 | ~$1.50 | **~$1.70** | Still ridiculously cheap |
| M365 + Graph | $0 | throttling risk | **$0 (risky)** | 15K/mo is 500/day, at the edge of throttling. Not recommended at this scale. |

### Scale (1,000 missionaries, 20,000 inbound / 150,000 outbound per month)

| Provider | Inbound | Outbound | **Total** | Notes |
|---|---:|---:|---:|---|
| SendGrid Pro 300K | $0 (still free) | ~$300 | **~$300** | Pro tier for dedicated IP and higher deliverability |
| ACS Email (send) + SendGrid (receive) | $0 | ~$110 | **~$110** | Only viable as a split — ACS cannot receive |
| Cloudflare | $0 (unlimited) | ~$51 | **~$56** | $5 base + 147,000 at $0.35/1,000 |
| Postmark 300K | (included) | $175 | **$175** | Strong deliverability |
| Mailgun Scale | (included) | $90+ (custom) | **~$100–200** | Negotiable at this level |
| MailerSend | (custom) | ~$150 | **~$150** | Priced comparably |
| Amazon SES | ~$2 | ~$15 | **~$17** | Cheapest by 5–10× |
| M365 + Graph | — | **not viable** | — | Exceeds daily quota; tenant would be throttled or suspended |

## Recommendations by stage

**Initial + Low traffic**: **Cloudflare.** $0/month, inbound unlimited and uncapped, and it is the only option where a failure is an SMTP error the sending server retries rather than a message we have already taken responsibility for. Nothing about volume forces a decision at this stage.

**Growth**: Three viable paths:
- **Stay on Cloudflare** and add Workers Paid at $5/mo for outbound. Zero friction, one fewer vendor, and inbound stays uncapped.
- **Split: Cloudflare in, Postmark out** at ~$16.50/mo. Buys the best deliverability reputation available for the claim-link email, which is the hardest delivery in the system.
- **Split: ACS Email for outbound, Cloudflare for inbound.** Buys managed-identity send with no API key to rotate, at the cost of two vendors. ACS cannot receive, so a clean single-vendor move to Azure is not on the table at any price.

Recommendation: **stay on Cloudflare for inbound permanently**, and let outbound be decided at Phase 8 by deliverability evidence rather than by cost.

**Scale**: Reconsider. At 1,000 missionaries the pricing spread is large enough to matter:
- **Amazon SES** (~$17/mo) is the cheapest and handles both directions, at the cost of adding AWS to an all-Azure stack.
- **Cloudflare** (~$56/mo) is the cheapest single vendor that needs no second cloud.
- **ACS Email** (~$110/mo) for outbound only, leaving inbound elsewhere.
- **Postmark** (~$175/mo) is more expensive but has the best deliverability reputation.
- **SendGrid Pro** (~$300/mo) is comfortable but pricey.

If we hit scale, the right call depends on operational preferences by that point (all-Azure vs. best-of-breed) and how much deliverability trouble we've actually experienced. Migrating outbound between providers is a 1–2 week job; migrating inbound is an MX-record change plus a webhook change.

## Split vs. single-provider

Some teams split "send with X" from "receive with Y." For this project I recommend **against** splitting:

- Both sides of the pipeline benefit from single-vendor observability (one dashboard, one bounce/complaint pipeline, one set of DNS records).
- The service replies to inbound mail *as* the address it was written to, with `In-Reply-To` threading — see [plan.md](plan.md). Splitting puts the receiving domain and the sending domain under different vendors' authentication, which is workable but is exactly the kind of DNS/DKIM alignment problem that is miserable to debug remotely.
- Save your architectural complexity budget for the actual application, not for optimizing $10/mo.

**Note that choosing ACS Email forces a split**, since it cannot receive. That is the main argument against it, and it is a stronger one than the cost comparison.

**Cloudflare-in / Postmark-out is the one split worth considering**, because it puts each vendor where it is strongest: SMTP-level retry semantics on the irreplaceable half, and an established sender reputation on the half that has to reach a Gmail inbox behind Proofpoint. It is still two vendors and two dashboards — but unlike the ACS split, both halves are chosen rather than forced.

## Deliverability tips (all providers)

- **Warm up gradually.** Send small volume for the first two weeks; ramp up. This applies especially to Pro/dedicated-IP plans.
- **DMARC policy = `quarantine`** on the sending subdomain from day one. `reject` at apex once we're stable.
- **List-Unsubscribe header** on every outbound. Required by Gmail/Yahoo since Feb 2024 for bulk senders (>5K/day). Our unsubscribe-token endpoint doubles as the target.
- **One sending subdomain, `mail.pdayletters.com`.** Envelope sender and DKIM signing live there for every class of outbound mail. Splitting digests and system mail across two subdomains isolates reputation in theory, but at this volume it halves the sending history behind each one, and low-volume subdomains are treated worse than a single established one.
- **Bounce and complaint webhooks.** All providers support these. Automatically remove hard-bounced addresses from ACLs; alert the owner when a complaint arrives.

## Migration friction ranking

We are starting on Cloudflare. If we later need to move:

| Move | Effort | Rationale |
|---|---|---|
| Cloudflare → Resend (receive) | ~3–4 days | The designated retreat. Change MX, port the Worker to a Svix-verified intake Function, fetch content by API. Its metadata-only webhook is the one that fits behind Static Web Apps without hitting the 30 MB request ceiling. **Budget for Pro at $20/mo** — the Free quota is the reason we aren't there already. |
| Cloudflare → Postmark (receive) | ~1 week | Same shape, plus a 30 MB request ceiling with no headroom and no HMAC webhook signing. |
| Cloudflare → SendGrid or Mailgun (receive) | ~1 week | Same, plus SendGrid's discard-after-retry behavior or Mailgun's undocumented size limit. |
| Cloudflare → Postmark or Resend (send) | ~2–3 days | Swap the send binding for a REST client and move DKIM records. Reply threading has to be rebuilt by hand, since nothing else has `message.reply()`. |
| Anything → ACS Email (receive) | **impossible** | ACS cannot receive mail. |
| Anything → M365 (send) | Not recommended | Not designed for programmatic transactional send at any real volume. |
| Anything → Amazon SES | ~1 week per direction | Full-fat AWS setup; adds cross-cloud IAM. |

## Bottom line

**Decision: Cloudflare for inbound, revisit outbound at Phase 8.**

- **Cloudflare Email Routing for ingest.** MX on the apex of `pdayletters.com`, an Email Worker that streams the raw MIME straight to Blob Storage and enqueues the ULID. Inbound is unlimited, uncapped, and free on every plan, and it is the only option where a failure is an SMTP error the sending server retries rather than a message we have already accepted responsibility for.
- **Uncapped inbound is what decided it.** Resend's design is better in almost every respect downstream of ingest, but its Free plan counts received mail against a 100/day allowance shared with outbound — and **documents nothing about what happens when that cap is hit**. Bulk-forwarding an entire mission's letters in one sitting is a first-class supported scenario, it lands squarely on that limit, and the mail involved cannot be re-sent. That is the wrong place for an undocumented failure mode at any price.
- **It removes a public endpoint rather than securing one.** Every webhook-based provider requires us to stand up a URL and then defend it. The Worker has no HTTP surface at all, and it never traverses Static Web Apps, so the **30 MB SWA request limit stops applying**.
- **Two vendors total.** Everything is Azure or Cloudflare, and Cloudflare is already the DNS provider — so inbound mail adds no new relationship, bill, or account to secure. **The honest cost is runtimes, not vendors**: an Email Worker alongside Azure Functions means the component that touches every message reports to Workers Logs while everything else reports to App Insights, and it needs a storage SAS living outside Azure. Both are accepted deliberately.
- **This puts Stage 1 at $0 for email**, and combined with SWA Free it keeps the whole service to storage costs until real users arrive.
- **Outbound stays open until Phase 8.** Cloudflare's own sending ($5/mo, 3,000 included) is the default, but its reputation is young and the hardest delivery in this system — a claim link into a Gmail inbox behind Proofpoint — is the worst place to bet on that. **Postmark is the fallback for deliverability, Resend for ergonomics.** Verify Cloudflare's outbound header allowlist before committing: the design needs `In-Reply-To`, `References`, `Auto-Submitted`, `List-Unsubscribe`, and `List-Unsubscribe-Post`, and custom headers are allowlist-controlled.
- **Resend remains the designated fallback for inbound**, at Pro rather than Free. If Cloudflare disappoints, it is the only webhook provider whose design avoids the serverless request-size problem, and it stores messages on arrival so a dead endpoint loses nothing.
- **Do not pick ACS Email.** It cannot receive mail, so it can only ever be half the solution.
- **Do not pick Mailgun.** Its maximum inbound message size is published nowhere and its retention docs contradict each other.
- **Never use M365 for outbound at scale.** Fine for early prototypes; migrate off before opening to non-family users.
