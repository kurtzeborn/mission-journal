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
| `forward_verified` | Contains a `message/rfc822` attachment (original `.eml`); original DKIM signature re-verifies against the `missionary.org` public key; forwarder is on the target missionary's ACL | Yes |
| `forward_headers` | Original `.eml` attached with `@missionary.org` `From`, but DKIM re-verify fails (broken by an intermediate hop, key rotated, etc.); forwarder is on the target missionary's ACL | Yes |
| `forward_inline` | Only inline body-text evidence of missionary origin (e.g. `---------- Forwarded message ---------` separator with `From: elder.smith@missionary.org`); forwarder is on the target missionary's ACL | Yes |
| `rejected` | None of the above — no `@missionary.org` evidence, or forwarder is not on the target ACL, or authentication of the forwarder itself failed | No — drop silently, log to `rejected/` |

Design principles:

- **Never trust the `From:` header alone.** Always require SPF/DKIM/DMARC pass on the outer envelope (for `direct`) or on the forwarder (for any `forward_*` class).
- **The forwarder must be on the same ACL that grants them read access to the destination missionary's blog.** There is no separate "allowed forwarders" list — access implies forwarding rights.
- **Determine the target missionary from the `To:` / `Cc:` address token** (e.g. `elder-smith-a7f3@ingest.missionaryjournal.org`), then check the forwarder's authenticated email against that missionary's ACL.
- **Reject silently.** No bounce or error to the sender — bouncing leaks which addresses exist and invites probing.
- **Log every rejection** (sender, subject, timestamp, reason) to a `rejected/` blob or App Insights for audit, without storing the message body.

#### Extracting and de-duplicating forwards

Because anyone on a missionary's ACL can forward historical email, the intake code has to extract the "true" original message and check whether we already have it:

1. **Prefer `message/rfc822` attachments.** Outlook, Apple Mail, and Gmail's "forward as attachment" all embed the original as an rfc822 MIME part with all headers intact. Use these when present.
2. **Fall back to inline forwards.** Parse blocks starting with `---------- Forwarded message ---------` (Gmail), `Begin forwarded message:` (Apple Mail), or `-----Original Message-----` (Outlook). Extract original `From`, `Date`, `Subject`, and body text. Attachments in inline forwards are attached to the outer message rather than the inline block; associate them with the extracted original.

De-duplication key, in priority order:

1. **Original `Message-ID` header** — extracted from the `.eml` attachment when available. RFC 5322 requires global uniqueness; this is the ideal key.
2. **Content fingerprint** — SHA-256 of the normalized tuple `(original From, original Date truncated to the minute, original Subject, first 512 bytes of plaintext body)`. Used only when `Message-ID` is missing.

The dedupe index is a single Azure Table `deduplication` with `PartitionKey = missionary-slug`, `RowKey = originalMessageId or contentHash`, and a small value pointing at the existing `raw/` path. Lookup is milliseconds; cost is negligible.

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
raw/                                   Immutable archive. Never deleted.
  {missionary-slug}/
    {yyyy}/{mm}/{msgId}/
      message.eml                      Full raw MIME
      attachments/
        {original-filename}            Untouched originals (EXIF intact)
      metadata.json                    ingested-at, source, headers subset

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
```

Plus two Azure Tables in the same storage account:

- **`deduplication`** — `PartitionKey = missionary-slug`, `RowKey = originalMessageId or contentHash`. Value: `postId`, `sourceRawPath`, `firstSeen`.
- **`preferences`** — `PartitionKey = "user"`, `RowKey = lowercased email`. Value: per-user notification flags (see [Notification preferences](#notification-preferences)).

### Data model (posts.json entry)

```jsonc
{
  "id": "2020-07-06-a7f3",
  "class": "forward_verified",              // direct | forward_verified | forward_headers | forward_inline
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
  - `owner` — the missionary themself. Can invite, revoke, edit metadata, delete posts.
  - `admin` — designated family member (typically a parent). Same as owner except cannot change ownership.
  - `reader` — invited viewer. Read-only.
- **Invitations:** owner/admin enters an email address; that address is added to `acl.json`. First time the invitee signs in with that email via Google or MS, they get access.
- SWA route rules enforce that `/{missionary-slug}/*` requires an authenticated user whose email is in that slug's ACL. API calls check the same ACL server-side.
- **Forwarding is gated by the same ACL.** Anyone on a missionary's ACL can forward historical missionary emails to that missionary's ingest address; no separate forwarding allowlist exists.

### Notification preferences

Per-user (not per-missionary) preferences for outbound emails the service generates. Stored in the `preferences` Azure Table keyed by the user's authenticated email.

Initial preferences:

- **`dedupeAckEmails`** — bool, default `true`. Sends a short "we already have this one — thanks!" reply when a forwarded email is de-duplicated against an existing post. Every such reply contains an unsubscribe-style link ("Don't tell me again when you forward duplicates") that hits a Function endpoint to flip this preference off for the user.

Unsubscribe-style links use a signed short-lived token (HMAC of `{email, preference, expiry}` with a secret from Key Vault, valid ~30 days) so the target Function can authenticate the click without requiring the user to sign in. On click, the endpoint flips the flag and shows a small confirmation page ("OK, we'll stop sending those. Click here if you change your mind.").

Doubles as an end-to-end smoke test for the send-and-receive email pipeline: the ack reply exercises SendGrid send from `no-reply@mail.missionaryjournal.org`, and the click exercises the Function API.

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

### Phase 0 — Foundation
- Register `missionaryjournal.com` (or chosen domain).
- Create Azure subscription resource group.
- Set up SWA Standard with GitHub Actions deploy, custom domain, MS + Google auth providers.
- Storage account with `raw/` and `rendered/` containers; immutability policy on `raw/`.
- Key Vault + managed identity from Functions.

### Phase 1 — Manual ingest to render pipeline
- Skip email entirely first. Provide a "drop an .eml file in raw/{slug}/…" workflow.
- Build the render function: parses `.eml`, extracts text + HTML + attachments, produces `posts.json`, resizes photos, strips EXIF, generates search index.
- Build the reader UI: list posts, view post, photo album, client-side search. Path-based routing.
- Ship a demo journal you populate by hand.

### Phase 2 — Auth & ACL
- Wire up Google + MS providers in SWA.
- Implement `acl.json` gate: SWA route rules + API-level checks.
- Owner admin view: manage invitees, delete post, hide post, edit title.

### Phase 3 — Email intake
- Decide Option A vs B.
- Build the intake path end to end (email arrives → classify → dedupe → raw blob → queue → render).
- Message classifier: distinguish `direct` from `forward_verified` / `forward_headers` / `forward_inline` / `rejected`. Includes DKIM re-verification for `forward_verified` and forwarder-vs-ACL check for all `forward_*` classes.
- Original-message extractor: prefer `message/rfc822` attachments; fall back to inline block parsing across the three common forward formats (Gmail, Apple Mail, Outlook).
- Deduplication: `deduplication` table lookup keyed on original `Message-ID` (preferred) or content hash. On hit, append forwarder to existing post's `alsoSubmittedBy` and send the dedupe-ack reply (respecting user preference).
- Notification preferences: `preferences` table + signed-token unsubscribe endpoint for `dedupeAckEmails`.
- Address provisioning: onboarding creates missionary slug + tokenized email + initial ACL.
- Bounce/reject: any inbound mail whose `To`/`Cc` doesn't map to a known missionary token is dropped.

### Phase 4 — Polish
- Photo album view.
- Search UI refinement (highlights, snippets).
- Post editing / hiding.
- Owner-managed profile (display name, header image).

### Phase 5 — Offline archive export
- "Download my journal" builder Function.
- Packaged reader HTML that reads local JSON.

---

## Open questions to confirm

1. **Email intake:** Option A (Logic Apps + M365) or Option B (SendGrid Inbound Parse)?
2. **Address scheme:** tokenized (`elder-smith-a7f3@…`) confirmed?
3. **Moderation:** default hands-off, opt-in approval — OK?
4. **Post-mission:** read-only archive stays live indefinitely, plus downloadable offline zip — OK?
5. **Domain:** is `missionaryjournal.com` the intended name? (Alternatives: `missionjournal.app`, `elderjournal.com`, etc.)
6. **Roles:** three roles (`owner`, `admin`, `reader`) — right level of granularity?
