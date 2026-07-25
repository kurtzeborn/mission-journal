# Missionary Journal — Design Plan

## Vision

An automatic journal/blog service for LDS missionaries. A missionary CCs a personal ingest address on their weekly email home. The service captures the message and any attached photos, publishes them as a blog entry on the missionary's personal journal, and makes everything searchable. Access is controlled per-missionary. When the mission ends, the missionary can download a fully self-contained, offline-searchable archive of everything.

## Goals

- **Zero-effort authoring** for the missionary. If they can CC an address, they have a journal.
- **Preserve everything, exactly as received.** Raw MIME + original attachments are archived immutably so future features can reprocess history.
- **Cheap and simple.** Small monthly Azure spend, minimal moving parts, no self-hosted mail.
- **Private by default.** Each missionary maintains their own allowlist.
- **Offline-capable archive.** After the mission, download a packaged, self-contained journal that works from a folder or USB drive.

## Non-goals

- Cross-missionary search or discovery.
- Rich in-browser authoring (writing posts on the site). Email is the only authoring surface.
- Public-facing content or social features (comments, likes, follows).
- Self-hosted SMTP.

---

## High-level architecture

```
        Missionary                       Family/Friends
      writes email                            reads
            │                                   │
            ▼                                   ▼
   ┌──────────────────┐                ┌──────────────────┐
   │  Email provider  │                │  Static Web App  │◄── Google / MS auth
   │  (M365 or        │                │  (Standard tier) │
   │   SendGrid)      │                │  path routing:   │
   └────────┬─────────┘                │  /{missionary}   │
            │                          └────────┬─────────┘
            ▼                                   │
   ┌──────────────────┐                         │
   │   Intake         │                         │
   │  (Logic App or   │                         │
   │  Function on     │                         │
   │  webhook)        │                         │
   └────────┬─────────┘                         │
            │                                   │
            ▼                                   │
   ┌──────────────────┐                         │
   │  Blob: raw/      │  ◄──── immutable ────   │
   │  {missionary}/   │        raw MIME +       │
   │  {msgId}.eml     │        original         │
   │  + attachments   │        attachments      │
   └────────┬─────────┘                         │
            │                                   │
            ▼                                   │
   ┌──────────────────┐                         │
   │  Render function │                         │
   │  (queue-trig)    │                         │
   └────────┬─────────┘                         │
            │                                   │
            ▼                                   │
   ┌──────────────────┐                         │
   │  Blob: rendered/ │                         │
   │  posts.json      │◄────────────────────────┤
   │  search.json     │                         │
   │  photos/*.webp   │                         │
   └──────────────────┘                         │
                                                │
                                          ┌─────▼─────┐
                                          │ Functions │
                                          │ API for   │
                                          │ auth /    │
                                          │ ACL /     │
                                          │ admin     │
                                          └───────────┘
```

---

## Design decisions

### Email ingestion (top two, pick one)

Both are simple and reliable. Decision pending.

#### Message classification (applies to both options)

Inbound messages fall into one of these classes based on what the intake code can verify. Only classified-as-accepted messages are written to `raw/`; everything else is dropped silently.

| Class | Detection | Publish? |
|---|---|---|
| `direct` | Authenticated sender is `@missionary.org` (SPF/DKIM/DMARC all pass per `Authentication-Results`) | Yes |
| `forward` | Forwarder is on the target missionary's ACL, and the original message can be extracted either from a `message/rfc822` attachment or from inline forwarded-text separators | Yes |
| `rejected` | None of the above — no `@missionary.org` evidence, or forwarder is not on the target ACL, or authentication of the forwarder itself failed | No — drop silently, log to App Insights |

Provenance for `forward` messages is captured in an `extractionSource` metadata field for audit/debug rather than as a separate trust class. Possible values: `rfc822_dkim_verified` (embedded `.eml` present and its DKIM re-validates against the `missionary.org` public key), `rfc822_dkim_broken` (embedded `.eml` present but DKIM re-verify failed — broken by an intermediate hop or key rotation), `inline_gmail`, `inline_outlook`, `inline_apple`. All are published the same way; the field exists so we can later filter or requery historical ingests if a specific extractor turns out to be buggy.

Design principles:

- **Never trust the `From:` header alone.** Always require SPF/DKIM/DMARC pass on the outer envelope (for `direct`) or on the forwarder (for a `forward`).
- **The forwarder must be on the same ACL that grants them read access to the destination missionary's blog.** There is no separate "allowed forwarders" list — access implies forwarding rights.
- **Determine the target missionary from the `To:` / `Cc:` address token** (e.g. `elder-smith-a7f3@ingest.missionaryjournal.org`), then check the forwarder's authenticated email against that missionary's ACL.
- **Reject silently.** No bounce or error to the sender — bouncing leaks which addresses exist and invites probing.
- **Log every rejection** to App Insights (sender, subject, reason, timestamp — no message body). Rejected messages are not archived to blob storage.

#### Extracting and de-duplicating forwards

Because anyone on a missionary's ACL can forward historical email, the intake code has to extract the "true" original message and check whether we already have it — while being tolerant of the small variations email trips through (quoted-reply prefixes, stripped signatures, MIME re-encoding, missing attachments, minor date/time-zone drift).

**Extract the original:**

1. **Prefer `message/rfc822` attachments.** Outlook, Apple Mail, and Gmail's "forward as attachment" all embed the original as an rfc822 MIME part with headers intact.
2. **Fall back to inline forwards.** Parse blocks starting with `---------- Forwarded message ---------` (Gmail), `Begin forwarded message:` (Apple Mail), or `-----Original Message-----` (Outlook). Extract original `From`, `Date`, `Subject`, and body text.
3. **Associate outer-message attachments with the extracted original** in the inline case (webmail forwards typically re-attach photos to the outer message rather than embedding them in the inline block).

**Match key priority:**

1. **Exact match on original `Message-ID` header** — extracted from the embedded `.eml` when available. A hit here is a certain match; stop and treat as duplicate.
2. **Fuzzy match** — when no `Message-ID` is available (inline forwards, some hosts strip it), score candidate posts against the incoming message and declare a match at total score ≥ **0.90**.

**Fuzzy match — hard gates (must-match, not scored):** candidates only advance to scoring if **both** of these match the incoming message exactly:

- `originalFromLower` — exact string equality (both sides lowercased). Sender is a hard identity signal; two messages from different missionary accounts are never duplicates of each other.
- `originalDateDay` — exact `YYYY-MM-DD` equality on the day derived from the original `Date:` header. Missionaries send weekly, so same-day-different-sender or different-day-same-sender virtually never represents a duplicate in practice.

The bucket query is therefore a direct equality lookup: `PartitionKey = missionary-slug AND originalFromLower = <incoming> AND originalDateDay = <incoming>`. Typically returns 0–2 candidates.

Messages that don't satisfy both gates are treated as new posts — no scoring performed.

**Fuzzy match — scoring stage (only for candidates that pass the gates):** two normalized text features compared with the **same** algorithm — **Jaro–Winkler** — and combined as a weighted sum. Weights sum to 1.0.

| Feature | Normalization | Weight |
|---|---|---|
| `subjectNormalized` | Iteratively strip leading `Re:` / `Fw:` / `Fwd:` tokens **and** any `[…]` bracketed prefix (e.g. `[EXTERNAL]`, `[SPAM]`, `[External Sender]`) until neither pattern matches; collapse internal whitespace; lowercase. Compare the full normalized string. | 0.35 |
| `bodyHead200` | Strip quoted-reply lines (`^>`), strip signature blocks (from `-- \n` or the first `Sent from my …` line onward), collapse whitespace, lowercase, then take the **first 200 characters**. | 0.65 |

**Threshold:** total score ≥ **0.90** → duplicate. Below 0.90 → treat as new post.

Rationale for the design:

- **Sender and date as hard gates** eliminate an entire class of false positives (e.g. two unrelated Week-14 emails on the same day from different missionaries) and make the bucket query a trivial direct lookup instead of a range scan.
- **One algorithm (Jaro–Winkler) for both features.** Mixing SimHash + Jaro–Winkler + Jaccard was three different tuning knobs solving essentially the same "how similar are these two strings" question. On strings ≤200 chars Jaro–Winkler is fast, produces well-calibrated scores in `[0, 1]`, and tolerates the small edits email clients introduce (extra whitespace, punctuation, minor re-wording) without any tokenization decisions.
- **Body weighted higher (0.65) than subject (0.35)** because subjects are short, aggressively rewritten by clients, and often literally identical across a mission (`Week 14`, `Update`); the body opening is much harder to match by coincidence between two unrelated messages that already share sender and date.
- **Attachments dropped from scoring.** Attachment content is high-noise as a dedup signal: recurring assets (mission logo, repeated photos across weekly emails) inflate similarity, and forwarding clients routinely re-encode, rename, strip inline images, or fail to re-attach originals — so its true signal-to-noise for detecting *the same message* is worse than expected. Sender + date gates plus a body-head comparison catch the target case ("someone re-forwarded a message we already have") reliably.
- **First 200 chars, not full body.** For deciding whether two forwards represent the same original the opening is more than enough — greetings and the first sentence or two are highly discriminating. Full-body hashing was expensive to compute, expensive to store, and easily thrown off by mid-body quoted-reply interleaving.

**Trade-off:** The day-level date gate assumes the original `Date:` header lands on the same calendar day for every copy of a given message. This holds virtually always for forward-as-attachment (`message/rfc822` preserves the original date byte-for-byte) but *could* fail for an inline forward if the forwarder's mail client re-emits the date in a different time zone that shifts the calendar day. In practice this is rare, and the archived raw MIME means we can hand-merge any missed dupes later without data loss.

**Threshold tuning.** The 0.90 threshold and per-feature weights are the starting point. Because raw MIME is archived and the dedup table is updated on every ingest, we can rescore historical data at any time to tune weights and threshold without asking users to resubmit.

**On dedup hit:** don't create a new post. Update the existing post's `alsoSubmittedBy` array with the forwarder's email and timestamp. Send a courtesy acknowledgment reply (see [Notification preferences](#notification-preferences)) unless suppressed for that user.

**Post ordering:** posts are sorted by the **original `Date:` header**, not `receivedAt`. Forwards land in their correct historical position in the timeline. `receivedAt` is retained on each post for audit and for a "Recently added" ribbon in the reader UI.

#### Option A: Logic Apps + M365 shared mailbox *(recommended if we keep M365 in the mail path)*
- One shared mailbox in the tenant, e.g. `journal@missionaryjournal.com` (shared mailboxes are free under 50 GB, no license required).
- Per-missionary addresses via aliases or tokenized local-parts routed to the same shared mailbox (catch-all rule or explicit aliases).
- Logic App trigger: **"When a new email arrives in a shared mailbox (V2)"**.
- Actions: fetch raw MIME via HTTP to Graph → write `.eml` and attachments to blob `raw/{missionary}/{yyyy}/{mm}/{msgId}/` → enqueue a message for the render function.
- Retains M365 spam filtering, transport rules, and archival in front of the pipeline.
- Cost: pennies/month; Logic Apps Consumption pricing plus shared mailbox is free.

#### Option B: SendGrid Inbound Parse
- MX record on `missionaryjournal.com` points at SendGrid.
- SendGrid POSTs parsed multipart form (headers, text, HTML, attachments) to one HTTPS Function endpoint.
- Function writes raw payload to `raw/` blob and enqueues render.
- No Exchange involvement. Free tier easily covers expected volume.
- Trade-off: SendGrid becomes the inbound provider; no M365 mail flow rules.

### Missionary routing

**Path-based**: `missionaryjournal.com/{missionary-slug}`.
- One TLS certificate, one origin, no CORS quirks for the future offline packager.
- Slugs are chosen at onboarding (e.g. `elder-smith-2026`).

### Address scheme *(review)*

Proposed: **tokenized** — `elder-smith-a7f3@missionaryjournal.com`.
- Random 4-char suffix prevents strangers from guessing addresses and spamming a missionary's journal.
- Friendly enough to remember once written down.
- Missionary can rotate the token if the address leaks.

Alternative: friendly-only (`elder-smith@…`), simpler but more spam-prone.

### Storage layout

Single storage account, cool-tier by default (photos rarely re-read after posting).

```
raw/                                   Preserved archive. Write-once by
  {missionary-slug}/                   convention; container-level
    {msgId}/                           soft-delete + versioning enabled.
      message.eml                      Full raw MIME
      attachments/
        {original-filename}            Untouched originals (EXIF intact)
      metadata.json                    ingested-at, class, extractionSource,
                                       headers subset

rendered/                              Rewritable. Regenerated by render function.
  {missionary-slug}/
    posts.json                         Array of published post objects
    search-index.json                  MiniSearch prebuilt index
    photos/
      {photo-id}/
        original.jpg                   EXIF-stripped copy for site display
        large.webp                     ~1600px longest edge
        thumb.webp                     ~400px for album grid

config/
  {missionary-slug}/
    profile.json                       Display name, slug, header photo, token
    acl.json                           Email allowlist + roles
  preferences.json                     Per-user notification preferences,
                                       keyed by lowercased email
```

Plus one Azure Table in the same storage account:

- **`deduplication`** — `PartitionKey = missionary-slug`, `RowKey = originalMessageId or contentHash`. Bucketing (hard-gate) columns: `originalFromLower`, `originalDateDay` (`YYYY-MM-DD`). Scoring columns: `subjectNormalized`, `bodyHead200`. Audit columns: `originalDateFull` (ISO-8601), `postId`, `sourceRawPath`, `firstSeen`. See [fuzzy scoring](#extracting-and-de-duplicating-forwards).

Per-user notification preferences live in a single JSON blob at `config/preferences.json` — a map keyed by lowercased email address. At expected scale (dozens of missionaries × their ACLs) the whole file is a few KB, updates are rare (a user clicks "stop sending me acks" once, ever), and the write-the-whole-blob update pattern is simpler than a table-row schema for a single flag. If contention ever becomes a real issue we can migrate to a `preferences` table without any user-visible change.

### Data model (posts.json entry)

```jsonc
{
  "id": "2020-07-06-a7f3",
  "class": "forward",                       // direct | forward
  "extractionSource": "rfc822_dkim_verified", // direct | rfc822_dkim_verified | rfc822_dkim_broken | inline_gmail | inline_outlook | inline_apple
  "originalDate": "2020-07-06T18:04:22Z",   // from the original message; drives sort order
  "receivedAt": "2026-07-25T12:14:00Z",     // when this ingestion actually happened
  "subject": "Week 34 - miracles in Manaus",
  "bodyHtml": "<p>…</p>",
  "bodyText": "…",
  "originalMessageId": "<CAB=…@mail.missionary.org>",  // dedupe key when available
  "originalFrom": "elder.smith@missionary.org",
  "photos": [
    { "id": "p_9a2c", "width": 4032, "height": 3024, "caption": null }
  ],
  "sourceRawPath": "raw/elder-smith-2026/2020/07/{msgId}/message.eml",
  "alsoSubmittedBy": [
    { "email": "mom@example.com", "receivedAt": "2026-08-01T15:00:00Z" }
  ]
}
```

### Photo handling

- **Archive (raw/):** originals preserved byte-for-byte, EXIF intact, filenames preserved. Never modified.
- **Site display (rendered/):** EXIF stripped (including GPS), re-encoded to WebP in two sizes (`large`, `thumb`). Original resolution kept as `original.jpg` (also EXIF-stripped) for full-screen viewing and eventual download.
- **Album view:** aggregated grid across all posts for a missionary; each thumb links to the post it belongs to.
- Because raw is preserved, we can always reprocess (e.g. different sizes, HEIC support, face detection later) without asking the missionary for anything.

### Search

**Client-side, MiniSearch.**
- Render function builds `search-index.json` per missionary on every update.
- Web app loads it on first visit to that missionary's journal; searches run in-browser.
- Works on mobile browsers with no special handling. Total index size for a full 2-year mission is expected to be well under 1 MB.
- Same index file is bundled into the offline archive package — search continues to work with zero backend.

### Access control

- **Auth:** Static Web Apps Standard with Microsoft and Google identity providers.
- **Model:** per-missionary allowlist keyed on the authenticated user's email address.
- **Roles per missionary journal:**
  - `owner` — full admin rights: invite, revoke, edit metadata, delete posts, add/remove other owners, rotate the ingest-address token. **Multiple owners allowed** so the missionary can share admin duties (typically with a parent) without a separate role tier. There is always at least one owner — the "remove owner" action refuses if it would drop the count to zero.
  - `reader` — invited viewer. Read-only.
- **Invitations:** an owner enters an email address and a role; that address is added to `acl.json`. First time the invitee signs in with that email via Google or MS, they get access.
- SWA route rules enforce that `/{missionary-slug}/*` requires an authenticated user whose email is in that slug's ACL. API calls check the same ACL server-side.
- **Forwarding is gated by the same ACL.** Anyone on a missionary's ACL can forward historical missionary emails to that missionary's ingest address; no separate forwarding allowlist exists.

### Notification preferences

Per-user (not per-missionary) preferences for outbound emails the service generates. Stored in the `preferences` Azure Table keyed by the user's authenticated email.

Initial preferences:

- **`dedupeAckEmails`** — bool, default `true`. Sends a short "we already have this one — thanks!" reply when a forwarded email is de-duplicated against an existing post. Every such reply contains an unsubscribe-style link ("Don't tell me again when you forward duplicates") that hits a Function endpoint to flip this preference off for the user.

Unsubscribe links point at the authenticated site settings page — `/{slug}/settings?pref=dedupeAckEmails` — where the recipient toggles the flag and it's persisted to `config/preferences.json`. Recipients are, by definition, ACL members already signed in via Google or Microsoft, so authentication is a single click at most. No signed tokens, no HMAC secret to manage, no expiry edge cases.

Doubles as an end-to-end smoke test for the send-and-receive email pipeline: the ack reply exercises SendGrid send from `no-reply@mail.missionaryjournal.org`, and the settings toggle exercises the preferences read/write path.

### Moderation / quarantine *(review)*

Proposed default: **hands-off**. Posts publish immediately. Missionary (owner) can edit the post title, hide, or delete via a lightweight authenticated admin view. Rationale: missionaries have limited P-day computer time; adding an approval step defeats the "zero effort" goal.

Optional per-missionary setting: **"require approval"**. If enabled, posts land in a pending list that owner or admin must approve before family sees them.

### Post-mission archive

- One-click "Download my journal" (owner only) produces a zip:
  - `index.html` — the same reader UI, but pointed at local files
  - `posts.json`, `search-index.json`
  - `photos/` — all `large.webp` + `original.jpg`
  - `raw/` — optional toggle to include the immutable archive too
- The zip is self-contained: open `index.html` in any browser and it works, search included.
- Site remains available in read-only mode indefinitely, or the missionary can request deletion.

### Journal Publish

*Last feature to be built, after everything else is stable.*

Assemble a physical hardcover photo book from a missionary's journal — all posts, in chronological order, with the photos — and route the print order to a photo-book print-on-demand provider.

**Provider evaluation** (verified July 2026):

| Provider | Public API? | Photo book product? | Referral / affiliate | Verdict |
|---|---|---|---|---|
| **Shutterfly** | No. `developers.shutterfly.com` returns HTTP 410 (Gone). The Commerce API is invitation-only for strategic retail partners; not open to individual developers. | Yes (top-of-market for photo books) | Yes, via Rakuten Advertising — link-based referrals only (~5% commission, 15-day cookie). Requires application/approval. | Only viable path is affiliate-link + manual upload. No automation possible. |
| **Blurb** | Historically public; increasingly gated over the years. Supports PDF-to-hardcover-photobook flows. | Yes | Yes, via Impact.com (~5% commission). | Solid #2 option if Lulu doesn't fit. |
| **Lulu** | **Yes, fully public and documented** at [developers.lulu.com](https://developers.lulu.com). No upfront fee, no minimum. RESTful, OpenID Connect, sandbox environment for testing. Hardcover photo books supported (3,000+ product configurations). | Yes — hardcover and softcover photo books in many trim sizes | No affiliate program needed — you buy at wholesale, mark up if you want. | **Recommended default.** |
| **Amazon KDP** | Print API not public for individual accounts; trade-book focus, not photo books. | No (not a photo-book product) | Amazon Associates for retail links only. | Not a fit. |

**Recommended approach: Lulu Print API only. Shutterfly + Rakuten considered and rejected — see below.**

#### Primary path — Lulu Print API

1. Owner clicks "Publish this journal as a book" in the admin UI.
2. A book-assembly Function builds a print-ready PDF from the missionary's posts:
   - Cover page (title, missionary name, mission dates, headline photo).
   - Table of contents by date.
   - One "chapter" per post: subject as heading, formatted body, embedded high-res photos, footer with original date.
   - Colophon.
3. Function calls Lulu's Print API with a `pod_package_id` for a hardcover photobook trim (e.g. 8"×10" hardcover, premium color: `0800X1000FCPRECW060UW444GXX`), passing signed URLs (short-lived SAS tokens on Blob Storage) for the interior + cover PDFs.
4. Owner reviews Lulu's returned quote (price + shipping options), enters shipping details, confirms.
5. Lulu prints and ships. Webhook updates order status in the missionary's admin view.

**Pricing model on our side:**
- Simplest: pass through Lulu's wholesale pricing at cost — the service adds no fee.
- Alternative: add a small service fee ($5–$10) to cover PDF assembly / storage.
- Alternative: embed a Lulu checkout where the owner pays Lulu directly; we never touch the money.

#### Why not Shutterfly + Rakuten?

- **No developer API.** Shutterfly's developer portal (`developers.shutterfly.com`) returned HTTP 410 (Gone) at investigation time (July 2026). Their Commerce API is invitation-only for strategic retail partners and is not open to individual services.
- **The only integration path is a manual affiliate-link handoff via Rakuten Advertising.** That means generating a zip of photos, presenting a deep link into Shutterfly's builder, and asking the owner to re-upload and rebuild the book from scratch. Worse UX than the Lulu path in every dimension: no automated cover/interior layout, no attributed order (only cookie-window attribution to Rakuten), and no server-visible status after handoff.
- **Rakuten approval is not guaranteed** for a private-audience service with no public content, so the affiliate flow may not even be provisionable when we want it.
- **Marginal revenue upside** (~5% affiliate commission on a subset of clicks with a 15-day cookie window) doesn't justify the second-provider code, secret management, or support surface.

If a user specifically wants Shutterfly, the manual path is always available to them without our involvement: they open Shutterfly directly, use the offline archive export (Phase 7) to obtain their photos, and upload manually.

#### Implementation notes

- The book-assembly service should be its own Function — or a Durable Function orchestration for the multi-step Lulu flow (quote → confirm → submit → status polling).
- Reuse the *same rendered content* the reader UI uses. Regeneration is idempotent; if new posts arrive after publish, the owner can regenerate.
- Cover design and layout: start with a single "classic" template. Expand to multiple templates only if there's demand.
- Use Lulu's **sandbox environment** for CI/CD and any test orders. Real production submits only from the deployed environment behind an owner-only confirmation.

#### Data-model additions

- `books/{missionary-slug}/{book-id}/` blob path stores generated interior/cover PDFs and a `manifest.json` recording which posts + photos were included and which provider + order ID was used.
- Per-book records in the missionary's profile for order history: `bookOrders: [{ id, provider, orderId, orderedAt, status, trackingUrl }]`.

#### Open questions for this feature

- Pass-through pricing, or add a small service fee?
- Allow readers (not just owner/admin) to order copies for themselves? (Grandparents will want copies too.)
- Fixed trim size / template initially, or configurable?

---

## Azure resource plan

| Resource | SKU | Purpose | Est. $/mo |
|---|---|---|---|
| Static Web Apps | Standard | Web UI + auth + managed Functions | ~$9 |
| Azure Functions | Consumption (via SWA managed) | Render, admin API, invite API | ~$0 |
| Logic App | Consumption | Email intake (if Option A) | <$1 |
| Storage account | Standard LRS, Cool tier default | Raw archive + rendered artifacts | <$2 for years of data |
| Key Vault | Standard | Graph/SendGrid secrets | ~$0.03 |
| Custom domain + wildcard cert | Managed by SWA | `missionaryjournal.com` | $0 (cert is managed) |
| M365 shared mailbox | Existing tenant | Inbound mail (Option A) | $0 |

**Rough total: ~$10–15/month** at low volume.

---

## Build plan (proposed phases)

Reordered to validate the highest-risk piece (email pipeline) first, with intentionally rudimentary UIs at each stage to confirm the plumbing works end-to-end before we invest in polish. See [docs/email-options.md](email-options.md) for the vendor / pricing comparison behind the email decisions in Phase 0.

### Phase 0 — Foundation
- Register `missionaryjournal.org` (or chosen domain).
- Create Azure subscription resource group.
- Storage account: containers `raw/` (soft-delete + versioning on), `rendered/`, `config/`. Table `deduplication`.
- Key Vault + managed identity for Functions (SendGrid API key, Lulu OAuth secret).
- App Insights instance (for rejection logging and general telemetry).
- Choose and provision the email provider (SendGrid or M365 shared mailbox). Set up DNS: MX record on the ingest subdomain, DKIM CNAMEs on the sending subdomain, DMARC policy on the apex.

### Phase 1 — Inbound email pipeline (receive → classify → save)
- Function endpoint that receives inbound mail (SendGrid Inbound Parse webhook, or Logic App poll from M365 shared mailbox).
- Classifier: `direct` / `forward_verified` / `forward_headers` / `forward_inline` / `rejected`. DKIM re-verification for `forward_verified`; forwarder-vs-ACL check for all `forward_*` classes.
- Original-message extractor: `message/rfc822` attachments first, then inline-forward fallback (Gmail / Apple Mail / Outlook separators).
- Write raw MIME + attachments to `raw/{slug}/{yyyy}/{mm}/{msgId}/`; log rejections to `rejected/`.
- ACL for this phase is a **hand-edited JSON blob** — no auth UI yet. Manually add test accounts.
- **Verification UI:** single unauthenticated page at `/admin/last-received` listing the most recent 50 messages in `raw/` (subject, class, sender, `receivedAt`). Just enough to see the pipeline is working.

### Phase 2 — De-duplication and outbound send
- Dedupe: exact `Message-ID` lookup first, then sender+date hard-gated Jaro–Winkler scoring over `subjectNormalized` + `bodyHead200` per [fuzzy scoring](#extracting-and-de-duplicating-forwards). Populate `deduplication` on every accepted message.
- Dedupe-hit path: update existing post's `alsoSubmittedBy`; send courtesy ack email via the outbound provider; respect `dedupeAckEmails` in `config/preferences.json`.
- Settings page fragment at `/{slug}/settings` with the `dedupeAckEmails` toggle (auth via SWA identity, no separate token layer). Unsubscribe links in ack emails deep-link here.
- **Verification:** hand-craft duplicate forwards from a test mailbox, watch the dedup table populate and the courtesy email arrive. Click the unsubscribe link, sign in if not already, flip the toggle on the settings page, resend a duplicate, confirm silence.

### Phase 3 — Render pipeline
- Queue-triggered render Function: parse raw `.eml` → text + HTML body → resize photos to WebP + strip EXIF → produce/update `rendered/{slug}/posts.json`, `search-index.json`, `photos/*`.
- Idempotent: rerunning against the same `raw/` yields the same rendered output. This is what lets us reprocess history when features change.
- **Verification:** extend the admin page to list rendered posts alongside a thumbnail strip; confirm posts sort by `originalDate`.

### Phase 4 — Reader UI (unauthenticated demo)
- Path-routed `/{missionary-slug}` reader: list posts sorted by `originalDate`, post view, photo album, MiniSearch client-side search.
- No auth yet — one hand-picked missionary slug set to `public: true` for smoke testing.

### Phase 5 — Auth & ACL
- SWA Standard with Google + Microsoft providers.
- Load `acl.json` from `config/{slug}/` and enforce via SWA route rules + API-level checks.
- Owner admin view: manage invitees, delete/hide posts, edit post title, rotate ingest-address token.
- Turn off the `public: true` bit from Phase 4.

### Phase 6 — Polish
- Photo album view (aggregated across all posts for a missionary).
- Search UI refinement (highlights, snippets, filters).
- Owner-managed profile (display name, header image).
- Optional per-missionary "require approval" moderation flag.

### Phase 7 — Offline archive export
- "Download my journal" Function bundles `index.html` + `posts.json` + `search-index.json` + `photos/` + (optionally) `raw/` into a self-contained zip.
- Packaged reader HTML reads local JSON — search still works.

### Phase 8 — Journal Publish
- Assemble a hardcover photo book from a missionary's posts + photos and place the print order via the Lulu Print API.
- Full design in [Journal Publish](#journal-publish), including why Shutterfly + Rakuten was ruled out.

---

## Open questions to confirm

1. **Email intake:** Option A (Logic Apps + M365) or Option B (SendGrid Inbound Parse)?
2. **Address scheme:** tokenized (`elder-smith-a7f3@…`) confirmed?
3. **Moderation:** default hands-off, opt-in approval — OK?
4. **Post-mission:** read-only archive stays live indefinitely, plus downloadable offline zip — OK?
5. **Domain:** is `missionaryjournal.com` the intended name? (Alternatives: `missionjournal.app`, `elderjournal.com`, etc.)
6. **Roles:** three roles (`owner`, `admin`, `reader`) — right level of granularity?
