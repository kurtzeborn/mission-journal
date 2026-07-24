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

#### Sender validation (applies to both options)

Missionaries send email from the Church-issued `@missionary.org` domain. The intake step **must discard any message whose validated sender is not `@missionary.org`** before writing to `raw/`. Specifically:

- Check the **authenticated sender** — the `From:` header address after confirming SPF/DKIM/DMARC results (`Authentication-Results` header) show `pass`. Do not trust `From:` alone; spoofers set arbitrary `From:` values.
- If the domain is not `missionary.org` (case-insensitive), drop the message silently. No bounce, no error to the sender — bouncing would leak that the address exists and invite probing.
- Also drop if SPF/DKIM/DMARC did not pass, even if the `From:` domain looks right. This prevents spoofed `missionary.org` mail from being ingested.
- Log rejections (sender, subject, timestamp, reason) to a `rejected/` blob or App Insights for audit, without storing the message body.

This filter is the single most important spam and impersonation defense; the rest of the pipeline can trust that every message in `raw/` genuinely originated from a missionary account.

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

### Data model (posts.json entry)

```jsonc
{
  "id": "2026-07-06-a7f3",
  "receivedAt": "2026-07-06T18:04:22Z",
  "subject": "Week 34 - miracles in Manaus",
  "bodyHtml": "<p>…</p>",
  "bodyText": "…",
  "photos": [
    { "id": "p_9a2c", "width": 4032, "height": 3024, "caption": null }
  ],
  "sourceRawPath": "raw/elder-smith-2026/2026/07/{msgId}/message.eml"
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
- Build the intake path end to end (email arrives → raw blob → queue → render).
- Address provisioning: onboarding creates missionary slug + tokenized email + initial ACL.
- Bounce/reject: any inbound mail whose `To`/`Cc` doesn't map to a known missionary token is dropped (or a Logic App bounce reply, TBD).

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
