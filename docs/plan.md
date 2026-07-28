# P-Day Letters — Design Plan

## Vision

An automatic weekly-letters archive for LDS missionaries. A missionary CCs a personal ingest address on their weekly email home. The service captures the message and any attached photos, publishes them as a post on the missionary's personal letters site, and makes everything searchable. Access is controlled per-missionary. When the mission ends, the missionary can download a fully self-contained, offline-searchable archive of everything.

## Goals

- **Zero-effort authoring** for the missionary. If they can CC an address, they have a letters site.
- **Preserve everything, exactly as received.** Raw MIME + original attachments are archived and never overwritten so future features can reprocess history.
- **Cheap and simple.** Small monthly Azure spend, minimal moving parts, no self-hosted mail.
- **Private by default.** Each missionary maintains their own allowlist.
- **Offline-capable archive.** After the mission, download a packaged, self-contained letters archive that works from a folder or USB drive.

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
   │  Blob: raw/      │  ◀──── preserved ────   │
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

### Domains

Four registered domains, one canonical:

| Domain | Role |
|---|---|
| **`pdayletters.com`** | **Canonical.** All web UI, auth, and outbound-email links point here. |
| `pdayemail.com` | 301 → `pdayletters.com` at the SWA edge, all paths preserved. |
| `pday.email` | 301 → `pdayletters.com` at the SWA edge, all paths preserved. |
| `missionaryjournal.org` | 301 → `pdayletters.com` at the SWA edge, all paths preserved. |

**Why one canonical web domain instead of serving all four?** Azure Static Web Apps scopes auth session cookies (and the OAuth relying-party redirect) to a single hostname. Sharing a signed-in session across sibling domains would require hand-rolling cross-domain token passing — fragile, extra security surface, no real user benefit given the redirect model already puts users on the canonical domain within one round-trip.

**Email ingest is accepted on all four subdomains**, since ingest has no session and multi-domain acceptance costs nothing:

- `{slug}@ingest.pdayletters.com`
- `{slug}@ingest.pdayemail.com`
- `{slug}@ingest.pday.email`
- `{slug}@ingest.missionaryjournal.org`

The intake function validates that the recipient domain is on an allowlist (`config/ingest-domains.json` — see [Storage layout](#storage-layout)) and then routes purely by slug; which domain was used is retained per-post as `ingestDomain` (see [Data model](#data-model-postsjson-entry)) so the courtesy ack email can reference the address the sender actually used.

**Outbound mail always originates from the canonical domain:** `no-reply@mail.pdayletters.com`. SPF/DKIM/DMARC are set up on `pdayletters.com` only, which keeps sender-authentication configuration simple. The body of a courtesy ack can name the ingest address the family submitted to for continuity ("You submitted to `elder.smith@ingest.pday.email` — thanks!"); the visible From address is unchanged.

### Email ingestion (top two, pick one)

Both are simple and reliable. Decision pending.

#### Message classification (applies to both options)

Inbound messages fall into one of these classes based on what the intake code can verify. Only classified-as-accepted messages are written to `raw/`; everything else is dropped silently.

| Class | Detection | Publish? |
|---|---|---|
| `direct` | Authenticated sender is `@missionary.org` (SPF/DKIM/DMARC all pass per `Authentication-Results`) | Yes |
| `forward` | Forwarder is on the target missionary's ACL, and the original message can be extracted either from a `message/rfc822` attachment or from inline forwarded-text separators | Yes |
| `rejected` | None of the above — no `@missionary.org` evidence, or forwarder is not on the target ACL, or authentication of the forwarder itself failed | No — drop silently, log to App Insights |

Provenance for `forward` messages is captured in an `extractionSource` metadata field for audit/debug: `rfc822` (embedded `.eml` was present) or `inline` (parsed from forwarded-text separators). The originating client (Gmail / Outlook / Apple Mail) and DKIM re-verify pass/fail are logged to App Insights at ingest time but not stored on the post — both can be re-derived from the preserved raw MIME if a specific extractor ever turns out to be buggy and we need to requery history.

Design principles:

- **Never trust the `From:` header alone.** Always require SPF/DKIM/DMARC pass on the outer envelope (for `direct`) or on the forwarder (for a `forward`).
- **The forwarder must be on the same ACL that grants them read access to the destination missionary's letters site.** There is no separate "allowed forwarders" list — access implies forwarding rights.
- **Determine the target missionary from the envelope recipient (SMTP `RCPT TO`), not the visible `To:` / `Cc:` headers** — see [Envelope recipient parsing](#envelope-recipient-parsing) below. BCC-only ingest is the dominant pattern (missionaries don't want the ingest address exposed to their family list), and BCC recipients are absent from delivered headers by design. Envelope-based routing works for `To:`, `Cc:`, and `Bcc:` uniformly.
- **Reject silently.** No bounce or error to the sender — bouncing leaks which addresses exist and invites probing.
- **Log every rejection** to App Insights (sender, subject, reason, timestamp — no message body). Rejected messages are not archived to blob storage.

#### Envelope recipient parsing

BCC is the dominant ingest pattern: a missionary types their family list in `To:` (occasionally friends in `Cc:`) and drops the ingest address in `Bcc:` so their family never sees, replies to, or forwards it around. BCC recipients are removed from the delivered message's `To:` and `Cc:` headers by design — header-based routing would miss BCC-only ingest on every message. The envelope, however, is preserved by every provider:

- **Option B (SendGrid Inbound Parse):** the webhook payload includes a top-level `envelope` field: `{"to": ["elder.smith@ingest.pdayletters.com"], "from": "elder.smith@gmail.com"}`. Use `envelope.to[0]` as the routing target.
- **Option A (M365 shared mailbox):** two viable extractions.
  1. **Per-missionary aliases on the shared mailbox** — add `{slug}@ingest.pdayletters.com` (and its three siblings) as an alias on the shared mailbox at onboarding. On fetch, Graph's `internetMessageHeaders` includes a `Delivered-To:` (or Exchange's `X-MS-Exchange-Recipient-Address`) naming the alias the message hit.
  2. **Catch-all + `Received:` chain parse** — the last hop of the `Received:` chain includes a `for <address>` clause naming the envelope recipient. Reliable and doesn't require alias management at onboarding.

**Multiple envelope recipients** (e.g. a family BCCs both companion elders' ingest addresses on the same email) — process each independently: run the full pipeline once per matched slug. Any envelope recipient whose domain isn't on the accepted list is ignored (log-only, no error).

**Envelope cannot be spoofed by the sender's client** — it's set by their outgoing SMTP server, not by their message composition. So header-vs-envelope mismatch is normal for BCC, but a stranger can't lie about the envelope to route a publish attempt at someone else's slug — and even if they could, the [message classifier](#message-classification-applies-to-both-options)'s ACL/DKIM check still gates publication.

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

The bucket query is therefore an in-memory scan of the missionary's already-loaded `posts.json`: filter posts whose `originalFrom` matches (case-insensitively) and whose `originalDate` day matches. Typically returns 0–2 candidates.

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

**Threshold tuning.** The 0.90 threshold and per-feature weights are the starting point. Because raw MIME is archived, we can rescore historical data at any time to tune weights and threshold without asking users to resubmit.

**Storage of truth.** Dedup does not use a separate Azure Table. `rendered/{slug}/posts.json` already contains every field the check needs (`originalMessageId`, `originalFrom`, `originalDate`, `subject`, `bodyText`), so ingest just loads that blob and scans it in memory. `subjectNormalized` and `bodyHead200` are computed on the fly against the 0–2 candidates that pass the sender+date gate — cheap enough that precomputing and storing them buys nothing.

**Concurrency.** A parent bulk-forwarding several weeks of missionary emails in quick succession is an entirely normal usage pattern, so ingests for a single slug can arrive in bursts. Handled with **optimistic concurrency on `posts.json`**:

1. Ingest loads `posts.json` and records its ETag.
2. Runs the dedup check against the loaded posts.
3. If duplicate: send the courtesy ack, done. Nothing written to `raw/` or `rendered/`.
4. If new: append the post skeleton in memory, `PUT` back to blob with `If-Match: <etag>`, then write `raw/{slug}/{msgId}/`, then enqueue render.
5. On `412 Precondition Failed` (a sibling ingest committed between our load and our write), restart at step 1. On the retry the newly-committed sibling post is now visible, so if it *was* a duplicate of ours we'll correctly ack instead of appending.

`raw/` is only written after the ETag write succeeds, so a lost race never leaves an orphaned raw folder to clean up. At weekly-per-missionary cadence — even with occasional 5–10-message bulk-forward bursts — collisions are infrequent and each retry is cheap (one JSON fetch + one hash compare). If contention ever becomes measurable we can move to a blob lease for stricter serialization, but the optimistic path is expected to hold for a long time.

**On dedup hit:** don't create a new post. Send a courtesy acknowledgment reply (see [Notification preferences](#notification-preferences)) unless suppressed for that user. We deliberately do not track who else has forwarded a given message — the courtesy reply is the only outward signal, addressed to the current forwarder alone. A `who-forwarded-what` history would be data we collect but never use.

**Post ordering:** posts are sorted by the **original `Date:` header**, not `receivedAt`. Forwards land in their correct historical position in the timeline. `receivedAt` is retained on each post for audit and for a "Recently added" ribbon in the reader UI.

#### Option A: Logic Apps + M365 shared mailbox *(recommended if we keep M365 in the mail path)*
- One shared mailbox in the tenant, e.g. `letters@pdayletters.com` (shared mailboxes are free under 50 GB, no license required).
- All four ingest domains (see [Domains](#domains)) are added as accepted domains on the tenant; per-missionary addresses land in the same shared mailbox via aliases or catch-all rules on each `ingest.` subdomain.
- Logic App trigger: **"When a new email arrives in a shared mailbox (V2)"**.
- Actions: fetch raw MIME via HTTP to Graph → write `.eml` and attachments to blob `raw/{missionary}/{msgId}/` → enqueue a message for the render function.
- Retains M365 spam filtering, transport rules, and archival in front of the pipeline.
- Cost: pennies/month; Logic Apps Consumption pricing plus shared mailbox is free.

#### Option B: SendGrid Inbound Parse
- MX records on each accepted `ingest.` subdomain (see [Domains](#domains)) point at SendGrid; SendGrid Inbound Parse supports multiple hosts on a single account, all delivering to one webhook.
- SendGrid POSTs parsed multipart form (headers, text, HTML, attachments) to one HTTPS Function endpoint.
- Function writes raw payload to `raw/` blob and enqueues render.
- No Exchange involvement. Free tier easily covers expected volume.
- Trade-off: SendGrid becomes the inbound provider; no M365 mail flow rules.

### Missionary routing

**Path-based on the canonical domain**: `pdayletters.com/{missionary-slug}` (see [Domains](#domains); the three non-canonical domains 301-redirect here so all paths continue to resolve).
- One TLS certificate, one origin, no CORS quirks for the future offline packager.
- **Slug is the raw local-part of the missionary's `@missionary.org` email**, lowercased. **No other transformation** — dots, underscores, and hyphens are kept verbatim. Examples:
  - `elder.smith@missionary.org` → `elder.smith`
  - `sister_johnson2@missionary.org` → `sister_johnson2`
  - `elder.jose.maria.garcia@missionary.org` → `elder.jose.maria.garcia`
- **Why no character rewrites?** Collapsing `.` / `_` / `-` into a single form would allow two distinct Church-issued addresses (`elder.smith` and `elder-smith`) to map to the same slug, breaking the very uniqueness guarantee we're inheriting. Passing the local-part through verbatim keeps `slug` in 1:1 correspondence with the `@missionary.org` address. URL-safety is not a concern — `.`, `_`, and `-` are all unreserved characters per RFC 3986, so `pdayletters.com/elder.smith` is a perfectly valid URL path.
- **Why derive it rather than have the missionary pick one?**
  - **Uniqueness is inherited from the Church's own email allocation** — they already deconflict `elder.smith` vs `elder.smith2` at the address level. No collision check needed on our side, no reservation flow at onboarding.
  - **No embedded year** to go stale mid-mission or look dated in the post-mission archive.
  - **Deterministic**: the intake code can compute the slug from the authenticated sender address alone — no lookup, no onboarding form field, no persistence of a slug-to-email map.
- If a missionary really wants a different-looking URL (say a nickname), we can add an optional friendly-alias redirect later without giving up the deterministic derivation as the source of truth.

### Ingest address scheme

The ingest address is `{slug}@ingest.{accepted-domain}` where `{accepted-domain}` is any of the four ingest domains listed in [Domains](#domains) (e.g. `elder.smith@ingest.pdayletters.com`, `elder.smith@ingest.pday.email`). The intake code parses the target letters site by extracting the local-part of the **envelope recipient** (SMTP `RCPT TO`) — see [Envelope recipient parsing](#envelope-recipient-parsing); the local-part **is** the slug regardless of which accepted domain was used and regardless of whether the address appeared in `To:`, `Cc:`, or `Bcc:`. Any envelope recipient whose domain isn't on the accepted list is rejected as if the mailbox didn't exist.

**Why no random token?** Earlier drafts proposed `{slug}-{4-char-token}@…` to make the address unguessable and spam-resistant. The [message classifier](#message-classification-applies-to-both-options) already rejects anything that isn't either a `direct` from the authenticated missionary or a `forward` from an ACL member — a stranger who guesses the address gets nothing published and no reply, only a logged-and-dropped rejection. Obscurity adds no meaningful defense on top of that, and it costs an ugly address, a token field in `profile.json`, extra parser logic, and an admin rotation UI. Rate-limiting a would-be flood attacker is better handled at the intake edge (SendGrid spam filtering, or Exchange Online Protection under Option A) than by an obscure local-part.

### Storage layout

Single storage account, cool-tier by default (photos rarely re-read after posting).

```
raw/                                   Preserved archive. Write-once by
  {missionary-slug}/                   convention; container-level
    {msgId}/                           soft-delete + versioning enabled.
      message.eml                      Full raw MIME
      attachments/
        {original-filename}            Untouched originals (EXIF intact)
      metadata.json                    ingested-at, extractionSource,
                                       headers subset

rendered/                              Rewritable. Regenerated by render function.
  {missionary-slug}/
    posts.json                         Array of published post objects
    search-index.json                  MiniSearch prebuilt index
    photos/
      {photo-id}/
        large.webp                     ~2400px longest edge (post + full-screen)
        thumb.webp                     ~400px for album grid

config/
  ingest-domains.json                  Accepted ingest-domain allowlist
  {missionary-slug}/
    profile.json                       Display name, slug
    acl.json                           Email allowlist + roles
```

Plus one Azure Table in the same storage account:

- **`users`** — `PartitionKey = "user"`, `RowKey = lowercased email address`. Identity columns: `displayName`, `authProvider` (`google` | `microsoft`), `firstSeenAt`, `lastSignInAt`. Preference columns: `dedupeAckEmails` (bool, default `true`); additional per-user preferences are just additional columns as they arrive.

No separate deduplication table — `rendered/{slug}/posts.json` is the dedup source of truth (see [Extracting and de-duplicating forwards](#extracting-and-de-duplicating-forwards) for the scan + concurrency model).

### Data model (posts.json entry)

```jsonc
{
  "id": "2020-07-06-a7f3",
  "extractionSource": "rfc822",             // direct | rfc822 | inline
  "originalDate": "2020-07-06T18:04:22Z",   // from the original message; drives sort order
  "receivedAt": "2026-07-25T12:14:00Z",     // when this ingestion actually happened
  "ingestDomain": "pday.email",             // which accepted ingest domain received the message
  "subject": "Week 34 - miracles in Manaus",
  "bodyHtml": "<p>…</p>",
  "bodyText": "…",
  "originalMessageId": "<CAB=…@mail.missionary.org>",  // dedupe key when available
  "originalFrom": "elder.smith@missionary.org",
  "photos": [
    { "id": "p_9a2c", "width": 4032, "height": 3024 }
  ],
  "sourceRawPath": "raw/elder.smith/{msgId}/message.eml"
}
```

### Photo handling

- **Archive (raw/):** originals preserved byte-for-byte, EXIF intact, filenames preserved. Never modified.
- **Site display (rendered/):** EXIF stripped (including GPS), re-encoded to WebP in two sizes:
  - `large.webp` (~2400px longest edge) — post-view display **and** full-screen viewing. Sized to cover 4K/5K desktop monitors and high-DPI tablets.
  - `thumb.webp` (~400px) — album grid.
- **Album view:** aggregated grid across all posts for a missionary; each thumb links to the post it belongs to.
- **Full-resolution downloads:** served on-demand by a small Function that reads the raw attachment, strips EXIF in-flight, and streams it back as JPEG. Downloads are rare enough that on-demand generation is cheaper than storing an EXIF-stripped copy of every photo.
- Because raw is preserved, we can always reprocess (different sizes, HEIC → WebP, face detection later) without asking the missionary for anything.

**Why WebP over JPEG for the renditions?** WebP compresses photos ~25–35% smaller than JPEG at visually-equivalent quality, which shows up in three places we care about: post-page load times over cellular, the size of the offline archive zip (Phase 7 — a 2-year mission's ~1000 photos), and monthly Blob egress. Compatibility isn't a concern in 2026: every modern browser, iOS 14+, Android, and standalone photo viewers open `.webp` natively. The raw archive stays in whatever format the phone produced (almost always JPEG), so JPEG is always available upstream — used by the on-demand download endpoint and by the photo-book PDF generator in Phase 8.

### Search

**Client-side, MiniSearch.**
- Render function builds `search-index.json` per missionary on every update.
- Web app loads it on first visit to that missionary's letters site; searches run in-browser.
- Works on mobile browsers with no special handling. Total index size for a full 2-year mission is expected to be well under 1 MB.
- Same index file is bundled into the offline archive package — search continues to work with zero backend.

### Access control

- **Auth:** Static Web Apps Standard with Microsoft and Google identity providers.
- **Model:** per-missionary allowlist keyed on the authenticated user's email address.
- **Roles per missionary's letters site:**
  - `owner` — full admin rights: invite, revoke, add/remove other owners, and edit/hide/delete any post (including editing the subject or body — for copy-editing, retroactive anonymization of names or locations, or fixing typos after publication). **Multiple owners allowed** so the missionary can share admin duties (typically with a parent) without a separate role tier. There is always at least one owner — the "remove owner" action refuses if it would drop the count to zero.
  - `reader` — invited viewer. Read-only for site content; can also download the offline archive and order a printed book for themselves (see [Post-mission archive](#post-mission-archive) and [Journal Publish](#journal-publish)).
- **Invitations:** an owner enters an email address and a role; that address is added to `acl.json`. First time the invitee signs in with that email via Google or MS, they get access.
- SWA route rules enforce that `/{missionary-slug}/*` requires an authenticated user whose email is in that slug's ACL. API calls check the same ACL server-side.
- **Forwarding is gated by the same ACL.** Anyone on a missionary's ACL can forward historical missionary emails to that missionary's ingest address; no separate forwarding allowlist exists.

### Notification preferences

Per-user (not per-missionary) preferences for outbound emails the service generates. Stored as columns on the user's row in the `users` Azure Table — same row that holds identity metadata (display name, auth provider, first-seen timestamp) so all per-user state lives in one place. Additional preferences are just additional columns.

Initial preferences:

- **`dedupeAckEmails`** — bool, default `true`. Sends a short "we already have this one — thanks!" reply when a forwarded email is de-duplicated against an existing post. Every such reply contains an unsubscribe-style link ("Don't tell me again when you forward duplicates") that hits a Function endpoint to flip this preference off for the user.

Unsubscribe links point at the authenticated site settings page — `/{slug}/settings?pref=dedupeAckEmails` — where the recipient toggles the flag and it's persisted to their `users` row. Recipients are, by definition, ACL members already signed in via Google or Microsoft, so authentication is a single click at most. No signed tokens, no HMAC secret to manage, no expiry edge cases.

Doubles as an end-to-end smoke test for the send-and-receive email pipeline: the ack reply exercises SendGrid send from `no-reply@mail.pdayletters.com` (the single canonical sender — see [Domains](#domains)), and the settings toggle exercises the `users` table read/write path.

### Moderation / quarantine

**Hands-off by design.** Posts publish immediately on ingest. Owners can edit any post's subject or body, hide, or delete via a lightweight authenticated admin view (see [Access control](#access-control)) — that gives them everything an approval workflow would, without slowing down the common case.

Rationale: missionaries have limited P-day computer time; adding a pending-approval step defeats the "zero effort" goal. Anything an approval queue would catch is equally fixable post-publish through the standard edit/hide/delete tools — usually before family notices, since owners are typically parents already watching for new posts. If real missionaries later ask for a pre-publish gate, we'll add it in response to that request rather than in anticipation of it.

### Post-mission archive

**Nothing about the site changes when a missionary comes home.** No "read-only mode" flip, no state transition, no admin action. The letters simply stop arriving. Owners retain full edit/hide/delete rights on individual posts; anyone on the ACL can still forward historical emails that surface later (an aunt finds an old email in her inbox two years post-mission and forwards it — it lands normally). Nothing on our side needs to happen.

**Anyone on the ACL** can, at any time (during or after the mission):

- **Download the offline archive** — one-click "Download my letters" produces a self-contained zip:
  - `index.html` — the same reader UI, but pointed at local files
  - `posts.json`, `search-index.json`
  - `photos/` — all `large.webp` + `thumb.webp`
  - `raw/` — optional toggle to include the preserved archive too
  - Open `index.html` in any browser and it works, search included. Grandparents get their own copy without going through the owner.

- **Order a printed book** — see [Journal Publish](#journal-publish). Any ACL member can order a copy for themselves.

**Owner-only actions:**

- **Permanent deletion.** An owner can request permanent deletion of the site and all archived content (raw, rendered, config, and per-missionary preferences). Guarded by an explicit typed confirmation to defend against misclicks.

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

1. Any ACL member clicks "Publish this journal as a book" in the reader UI.
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
| Custom domains + certs | Managed by SWA | `pdayletters.com` (canonical) + 3 redirect entry points | $0 (certs are managed) |
| M365 shared mailbox | Existing tenant | Inbound mail (Option A) | $0 |

**Rough total: ~$10–15/month** at low volume.

---

## Build plan (proposed phases)

Reordered to validate the highest-risk piece (email pipeline) first, with intentionally rudimentary UIs at each stage to confirm the plumbing works end-to-end before we invest in polish. See [docs/email-options.md](email-options.md) for the vendor / pricing comparison behind the email decisions in Phase 0.

### Phase 0 — Foundation
- Domains already registered: `pdayletters.com` (canonical), `pdayemail.com`, `pday.email`, `missionaryjournal.org`. Verify each in the SWA custom-domain UI; configure the three non-canonical domains as 301 redirects to the canonical.
- Seed `config/ingest-domains.json` with the four accepted ingest domains.
- Create Azure subscription resource group.
- Storage account: containers `raw/` (soft-delete + versioning on), `rendered/`, `config/`. Azure Table `users`.
- Key Vault + managed identity for Functions (SendGrid API key, Lulu OAuth secret).
- App Insights instance (for rejection logging and general telemetry).
- Choose and provision the email provider (SendGrid or M365 shared mailbox). Set up DNS on all four domains: MX records on each `ingest.` subdomain pointing at the provider; DKIM CNAMEs and DMARC policy only on `pdayletters.com` since it's the sole outbound sender.

### Phase 1 — Inbound email pipeline (receive → classify → save)
- Function endpoint that receives inbound mail (SendGrid Inbound Parse webhook, or Logic App poll from M365 shared mailbox).
- Classifier: `direct` / `forward` / `rejected` per the [message classification](#message-classification-applies-to-both-options) table. DKIM re-verification against the `missionary.org` public key for `forward` messages with an embedded `.eml`; forwarder-vs-ACL check for all `forward` messages. Provenance captured in the `extractionSource` metadata field.
- Original-message extractor: `message/rfc822` attachments first, then inline-forward fallback (Gmail / Apple Mail / Outlook separators).
- Append a bare post record to `rendered/{slug}/posts.json` (subject, body, original headers — `photos: []` for now) and write raw MIME + attachments to `raw/{slug}/{msgId}/`. Log rejections to App Insights only (sender, subject, reason, timestamp — no body).
- No dedup yet — every accepted message becomes a post. Any duplicates produced during bulk-forward testing get cleaned up when Phase 2 lands.
- ACL for this phase is a **hand-edited JSON blob** — no auth UI yet. Manually add test accounts.
- **Verification UI:** single unauthenticated page at `/admin/last-received` listing the most recent 50 messages in `raw/` (subject, class, sender, `receivedAt`). Just enough to see the pipeline is working.

### Phase 2 — De-duplication and outbound send
- Dedup at ingest time, scanning `rendered/{slug}/posts.json`: exact `originalMessageId` match first, then sender+date hard-gated Jaro–Winkler scoring over normalized subject + first 200 chars of body per [fuzzy scoring](#extracting-and-de-duplicating-forwards). Optimistic-concurrency retry on ETag conflicts.
- Ingest becomes conditional: on match-miss, append the post skeleton to `posts.json` with `If-Match` and write raw/; on match-hit, don't touch either and send a courtesy ack instead.
- Dedupe-hit path: send courtesy ack email via the outbound provider; respect `dedupeAckEmails` on the recipient's `users` row.
- Settings page fragment at `/{slug}/settings` with the `dedupeAckEmails` toggle (auth via SWA identity, no separate token layer). Toggle persists to the current user's `users` row. Unsubscribe links in ack emails deep-link here.
- **Verification:** hand-craft duplicate forwards from a test mailbox and confirm the raw folder count stays flat while the ack arrives. Bulk-forward five near-simultaneously to exercise the ETag-retry path. Click the unsubscribe link, sign in if not already, flip the toggle on the settings page, resend a duplicate, confirm silence.

### Phase 3 — Render pipeline
- Queue-triggered render Function: parse raw `.eml` → resize photos to WebP + strip EXIF → write photos to `rendered/{slug}/photos/*` and fill in the target post's `photos` array in `posts.json` (ETag-guarded, same as ingest). Rebuild `search-index.json`.
- Idempotent: rerunning against the same `raw/` yields the same rendered output. Post text and dedup fields are already in `posts.json` from Phase 1/2; render only fills in photo-related fields, so double-runs are safe.
- **Verification:** extend the admin page to list rendered posts alongside a thumbnail strip; confirm posts sort by `originalDate` and that photo arrays fill in shortly after ingest.

### Phase 4 — Reader UI (unauthenticated demo)
- Path-routed `/{missionary-slug}` reader: list posts sorted by `originalDate`, post view, photo album, MiniSearch client-side search.
- No auth yet — one hand-picked missionary slug set to `public: true` for smoke testing.

### Phase 5 — Auth & ACL
- SWA Standard with Google + Microsoft providers.
- Load `acl.json` from `config/{slug}/` and enforce via SWA route rules + API-level checks.
- Owner admin view: manage invitees, hide/delete posts, edit any post's subject or body (for copy-editing, retroactive anonymization of names or locations, or fixing typos after publication).
- Turn off the `public: true` bit from Phase 4.

### Phase 6 — Polish
- Photo album view (aggregated across all posts for a missionary).
- Search UI refinement (highlights, snippets, filters).
- Owner-managed profile (display name).

### Phase 7 — Offline archive export
- "Download my letters" Function bundles `index.html` + `posts.json` + `search-index.json` + `photos/` + (optionally) `raw/` into a self-contained zip.
- Packaged reader HTML reads local JSON — search still works.

### Phase 8 — Journal Publish
- Assemble a hardcover photo book from a missionary's posts + photos and place the print order via the Lulu Print API.
- Full design in [Journal Publish](#journal-publish), including why Shutterfly + Rakuten was ruled out.

---

## Open questions to confirm

1. **Email intake:** Option A (Logic Apps + M365) or Option B (SendGrid Inbound Parse)?
