# Email Provider Options and Pricing

This document compares the realistic options for the Mission Journal service's email needs, projects monthly cost across four growth scenarios, and gives a recommendation for each stage.

Prices listed here reflect publicly advertised pricing as of mid-2026. Providers change pricing regularly; verify at signup and don't lock in on numbers here.

## Requirements recap

- **Inbound**: receive emails at tokenized addresses on an ingest subdomain. Filter to messages classifiable as `direct` (from `@missionary.org`) or `forward_*` (forwarded by an ACL member). See [plan.md](plan.md).
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

### Azure Communication Services (ACS) Email

- **Pricing**: pay-per-use, no monthly base.
  - Send: $0.00025 per email + $0.00012 per MB of message size (headers + body + attachments).
  - Receive: $0.00025 per email + $0.00012 per MB.
- **Attachment limit**: 30 MB per message (send and receive).
- **Deliverability**: shared Azure sender pool; can request dedicated pool for a fee at scale.
- **Custom domain**: verified custom domain via DNS TXT records; DKIM/SPF managed automatically. Free.
- **Integration**: Event Grid → Function is the cleanest inbound path in Azure. Managed identity for send calls (no API key rotation).

### Postmark

- **Pricing**: no free tier. Inbound is included in the outbound message count (each inbound message costs one "message credit").
  - $15/mo for 10K messages
  - $50/mo for 50K
  - $115/mo for 150K
  - $175/mo for 300K
- **Attachment limit**: 10 MB by default (upgradeable to 25 MB by request).
- **Deliverability**: Regarded as the best in the industry for transactional email.
- **Custom domain**: DKIM + return-path setup via DNS. Free.

### Mailgun

- **Pricing**:
  - Free tier: gone as of 2023 (was 5K/mo).
  - Flex: $15/mo for 10K + $0.80–1.00 per additional 1K
  - Foundation: $35/mo for 50K
  - Growth: $80/mo for 100K
  - Scale: starts at $90/mo, custom for higher volume
- **Inbound**: "Routes" feature, included on all paid tiers. Free tier is receive-only historically but current status is unclear.
- **Attachment limit**: 25 MB.
- **Deliverability**: shared IP on lower tiers; dedicated on Growth+.

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

## Cost projections per scenario

Costs shown are **monthly**, in USD, and rounded. Assumes 4 MB average message size where per-MB pricing applies.

### Initial (1 missionary, 20 inbound / 50 outbound per month)

| Provider | Inbound cost | Outbound cost | **Total / month** | Notes |
|---|---:|---:|---:|---|
| SendGrid | $0 (free) | $0 (free tier) | **$0** | Trivially covered by free tier |
| ACS Email | ~$0.01 | ~$0.03 | **~$0.04** | Genuinely pay-per-use |
| Postmark | (included) | $15 | **$15** | No free tier |
| Mailgun | (included) | $15 | **$15** | No free tier |
| MailerSend | $0 (free) | $0 (free tier) | **$0** | Free tier fits |
| Amazon SES | ~$0.01 | ~$0.01 | **~$0.02** | Cheapest in raw cost |
| M365 + Graph | $0 | $0 | **$0** | Uses existing tenant |

### Low traffic (10 missionaries, 200 inbound / 1,000 outbound per month)

| Provider | Inbound | Outbound | **Total** | Notes |
|---|---:|---:|---:|---|
| SendGrid | $0 | $0 | **$0** | 1,000/mo is 33/day, well under the 100/day free ceiling |
| ACS Email | ~$0.15 | ~$0.75 | **~$1** | Pay-per-use scales linearly |
| Postmark | (included) | $15 | **$15** | Minimum plan |
| Mailgun | (included) | $15 | **$15** | Minimum plan |
| MailerSend | $0 | $0 | **$0** | 1K/mo fits free tier |
| Amazon SES | ~$0.02 | ~$0.10 | **~$0.12** | Absurdly cheap |
| M365 + Graph | $0 | $0 | **$0** | Within tenant quotas |

### Growth (100 missionaries, 2,000 inbound / 15,000 outbound per month)

| Provider | Inbound | Outbound | **Total** | Notes |
|---|---:|---:|---:|---|
| SendGrid | $0 | $0 | **$0** | 15K/mo is 500/day, still under 100/day only if we can burst \u2014 in practice we'd exceed on peak days. **Realistic:** move to Essentials ~$20/mo |
| SendGrid Essentials 50K | $0 | ~$20 | **~$20** | Comfortable headroom |
| ACS Email | ~$1.50 | ~$11 | **~$13** | Continues to scale linearly |
| Postmark | (included) | $50 | **$50** | 50K tier |
| Mailgun Foundation | (included) | $35 | **$35** | 50K tier |
| MailerSend Hobby | (included) | $28 | **$28** | 50K tier |
| Amazon SES | ~$0.20 | ~$1.50 | **~$1.70** | Still ridiculously cheap |
| M365 + Graph | $0 | throttling risk | **$0 (risky)** | 15K/mo is 500/day, at the edge of throttling. Not recommended at this scale. |

### Scale (1,000 missionaries, 20,000 inbound / 150,000 outbound per month)

| Provider | Inbound | Outbound | **Total** | Notes |
|---|---:|---:|---:|---|
| SendGrid Pro 300K | $0 (still free) | ~$300 | **~$300** | Pro tier for dedicated IP and higher deliverability |
| ACS Email | ~$15 | ~$110 | **~$125** | Cheapest big-provider option |
| Postmark 300K | (included) | $175 | **$175** | Strong deliverability |
| Mailgun Scale | (included) | $90+ (custom) | **~$100–200** | Negotiable at this level |
| MailerSend | (custom) | ~$150 | **~$150** | Priced comparably |
| Amazon SES | ~$2 | ~$15 | **~$17** | Cheapest by 5–10× |
| M365 + Graph | \u2014 | **not viable** | \u2014 | Exceeds daily quota; tenant would be throttled or suspended |

## Recommendations by stage

**Initial + Low traffic**: **SendGrid.** $0/month cost, Inbound Parse is unlimited on the free tier, deliverability is best-in-class from day one. Reduces surprises when we later hit paid tiers because we're already on the platform. Skips the friction of picking a paid provider for the first year.

**Growth**: Two viable paths, depending on preference:
- **Stay on SendGrid Essentials 50K** at ~$20/mo. Zero friction, same platform, minimal migration risk.
- **Move to ACS Email** at ~$13/mo. Single Azure bill, managed-identity auth (no API keys to rotate), Event Grid integration is the cleanest inbound path in Azure. Slightly lower cost but non-negligible migration work.

Recommendation: **stay on SendGrid** unless we hit a specific pain point (auditability, cost pressure, or wanting to eliminate the third-party dependency). The $7/mo savings of ACS isn't worth the migration effort.

**Scale**: Reconsider. At 1,000 missionaries the pricing spread is large enough to matter:
- **ACS Email** (~$125/mo) or **Amazon SES** (~$17/mo) are the cheapest.
- **Postmark** (~$175/mo) is more expensive but has the best deliverability reputation.
- **SendGrid Pro** (~$300/mo) is comfortable but pricey.

If we hit scale, the right call depends on operational preferences by that point (all-Azure vs. best-of-breed) and how much deliverability trouble we've actually experienced. Migrating outbound between providers is a 1–2 week job; migrating inbound is an MX-record change plus a webhook change.

## Split vs. single-provider

Some teams split "send with X" from "receive with Y." For this project I recommend **against** splitting:

- Both sides of the pipeline benefit from single-vendor observability (one dashboard, one bounce/complaint pipeline, one set of DNS records).
- Save your architectural complexity budget for the actual application, not for optimizing $10/mo.
- The only reason to split is if we hit an inbound-heavy scale where SendGrid's Inbound Parse limits become an issue — and there are no such limits.

## Deliverability tips (all providers)

- **Warm up gradually.** Send small volume for the first two weeks; ramp up. This applies especially to Pro/dedicated-IP plans.
- **DMARC policy = `quarantine`** on the sending subdomain from day one. `reject` at apex once we're stable.
- **List-Unsubscribe header** on every outbound. Required by Gmail/Yahoo since Feb 2024 for bulk senders (>5K/day). Our unsubscribe-token endpoint doubles as the target.
- **Distinct subdomains for sending vs. transactional.** `mail.missionaryjournal.org` for digests, `no-reply.missionaryjournal.org` for system emails. Isolates reputation.
- **Bounce and complaint webhooks.** All providers support these. Automatically remove hard-bounced addresses from ACLs; alert the owner when a complaint arrives.

## Migration friction ranking

If we start with SendGrid and later want to switch, expected effort:

| Move | Effort | Rationale |
|---|---|---|
| SendGrid \u2192 ACS Email (send) | ~1 week | Change SDK calls + DNS DKIM records. Business logic unchanged. |
| SendGrid \u2192 ACS Email (receive) | ~1 week | New MX record, new Event Grid handler, keep classification logic identical. |
| SendGrid \u2192 Postmark or Mailgun | ~2–3 days | Very similar APIs; mostly a client-library swap. |
| Anything \u2192 M365 (send) | Not recommended | Not designed for programmatic transactional send at any real volume. |
| Anything \u2192 Amazon SES | ~1 week per direction | Full-fat AWS setup; adds cross-cloud IAM. |

## Bottom line

- **Start with SendGrid.** Free, best-in-class, no decisions to defer. Configure DNS and Inbound Parse on `ingest.missionaryjournal.org`, and authenticate `mail.missionaryjournal.org` for sending.
- **Reassess at ~50K emails/month combined.** By then we'll have real usage data and can decide whether the ~$7/mo savings and cleaner Azure story of ACS Email justify a migration.
- **Never use M365 for outbound at scale.** Fine for early prototypes; migrate off before opening to non-family users.
