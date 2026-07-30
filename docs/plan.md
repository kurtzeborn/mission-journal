# P-Day Letters — Design Plan

## Vision

An automatic weekly-letters archive for LDS missionaries. A missionary BCCs one shared address on their weekly email home — or a parent forwards it. The service captures the message and any attached photos, publishes them as a post on the missionary's personal letters site, and makes everything searchable. Access is controlled per-missionary. When the mission ends, the missionary can download a fully self-contained, offline-searchable archive of everything.

## Goals

- **Zero-effort authoring** for the missionary. If they can BCC one address — or if a parent can forward — they have a letters site.
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

## External constraints

Facts about the world the design has to accommodate. These are not preferences — if one of them changes, several decisions downstream change with it.

- **⚠️ Missionaries keep access to their `@missionary.org` address for only 60 days after returning home.** (Confirmed July 2026.) This is the most consequential constraint in the plan. Every mechanism that works by proving control of that address — `direct` publishing, DMARC-verified identity, and `claim@` ownership recovery — has a hard expiry 60 days past homecoming. The design's whole response is to **convert that temporary proof into durable ownership before the window closes**; see [Ownership and the 60-day window](#ownership-and-the-60-day-window). Anything proposed later in this document that leans on a live `@missionary.org` mailbox must be checked against this.
- **`@missionary.org` runs Google Workspace behind Proofpoint, with DMARC at `p=quarantine`.** Verified by DNS lookup, July 2026:
  - **MX** → `aspmx.l.google.com` and friends. Inbound mail is Gmail, so missionary accounts are **Google identities, not Microsoft ones**.
  - **SPF** → `v=spf1 include:%{ir}.%{v}.%{d}.spf.has.pphosted.com ~all`. Outbound is relayed through **Proofpoint**, not Google directly.
  - **DMARC** → `v=DMARC1; p=quarantine; fo=1; rua=…@emaildefense.proofpoint.com`.

  This largely **de-risks the `direct` path**: an enforcing `p=quarantine` policy can only be maintained if the domain's own outbound mail aligns, so `Authentication-Results` on a genuine missionary email should show a DMARC pass. Phase 0 still confirms against a real message — relaxed alignment and a Proofpoint relay leave enough room that it's worth seeing an actual header rather than inferring one.

  It also clarifies **where filtering actually happens**. Proofpoint appears only in SPF, so it is the **outbound relay** — inbound mail to a missionary lands at **Gmail**, and Gmail's filtering is what our replies must satisfy. That is good news twice over: Gmail weights prior correspondence with a sender heavily, and Gmail's behavior can be tested against any ordinary Gmail account without needing a Church one. (Caveat: a tenant can route inbound through a third-party scanner via Google-side rules that DNS won't reveal, so this is the likely picture rather than a certain one.)
- **⚠️ We have no access to an `@missionary.org` account, and may not for a long time.** Every path that depends on one — `direct` classification, `claim@`, and the OAuth question above — must be **implemented blind and verified later**. This does not block the build, but it changes how the build has to be done: see [Building blind](#building-blind).
- **⚠️ It is unknown whether an `@missionary.org` Google account can sign in to third-party apps at all.** Google Workspace admins can block or allowlist third-party OAuth access tenant-wide, and an organization of this size and posture may well have done so. The design must not depend on the answer — and doesn't: the claim flow deliberately separates *proving control of the mailbox* (email) from *which identity owns the site* (OAuth), so a missionary who cannot use their Church account simply binds a personal one. Worth testing eventually, because it determines how the claim email should be worded.

### Building blind

Three of the constraints above cannot be verified until someone with a real `@missionary.org` account is available to test with. The response is not to stall, but to build so that **being wrong is cheap and immediately visible**.

**Make the missionary domain configuration, not a constant.** A `MISSIONARY_DOMAINS` Function app setting (default `missionary.org`) is what the classifier, slug derivation, and the `claim@` handler all check against. This single change converts "untestable" into "testable against a stand-in": point it at a domain we control — a test Google Workspace domain, or even a personal Gmail address during development — and the entire `direct` and `claim@` flow can be exercised end to end, including DMARC evaluation, slug derivation, claim-token issuance, sign-in binding, and the `verifiedMissionary` ACL write. It also costs nothing if the Church ever adds a second domain.

**Most of the risk isn't logic — it's header format.** Our code never performs DMARC itself; SendGrid does, and the classifier reads the resulting `Authentication-Results` header. So the classification *logic* is fully testable offline against hand-crafted `.eml` fixtures. What we genuinely cannot know is the exact shape of that header for real `missionary.org` mail routed through Proofpoint. That is a parsing question with a narrow failure surface, not an architectural unknown.

**Instrument for the first real message.** Because that first genuine missionary email is the actual test, it must produce a complete diagnostic rather than a silent drop:

- Log the **full `Authentication-Results` header verbatim** to App Insights for every message whose `From:` domain is in `MISSIONARY_DOMAINS`, whether it classifies or not.
- A message from a configured missionary domain that **fails** classification is logged at warning level with the parse failure and the raw header — never folded into the ordinary silent-rejection path, where it would be indistinguishable from spam.
- `raw/_inbox/` already retains the verbatim payload for 30 days, so a message misclassified by a header-parsing bug can be reprocessed after a fix rather than lost.

**Feature-flag `claim@`.** Keep the handler behind a setting so it can ship dark and be enabled once a real round-trip has been observed. Until then `claim@` accepts mail and does nothing, which is indistinguishable from the documented "ignored without reply" behavior and therefore leaks nothing.

**Accept that the first real missionary is the pilot.** The first onboarding should be someone we can talk to directly, so a failure is a conversation rather than a support ticket from a stranger. Everything above exists to make that conversation short.

---

## High-level architecture

```
     Missionary ──BCC──┐         ┌── forwards ── Family/Friends
    writes email       │         │                    reads
                       ▼         ▼                      │
            ┌──────────────────────────┐                ▼
            │  SendGrid Inbound Parse  │      ┌──────────────────┐
            │  MX on all 4 domains,    │      │  Static Web App  │◄─ Google / MS
            │  single address: post@   │      │  (Standard tier) │      auth
            └───────────┬──────────────┘      │  /{missionary}   │
                        │ webhook             └────────┬─────────┘
                        ▼                              │ x-ms-client-
            ┌──────────────────────────┐               │  principal
            │  Intake Function         │               ▼
            │  dump raw + enqueue.     │   ┌──────────────────────────┐
            │  No parsing. No logic.   │   │  Functions API           │
            └───────────┬──────────────┘   │  /api/content/{slug}/…   │
                        ▼                  │  /api/photo/{slug}/…     │
            ┌──────────────────────────┐   │  admin · ACL · claim     │
            │  Ingest Function         │   └───────────┬──────────────┘
            │  classify · route by     │               │ ACL check,
            │  sender · dedupe         │               │ then stream
            └───────────┬──────────────┘               │
                        ▼                              │
            ┌──────────────────────────┐               │
            │  Blob: raw/{slug}/       │               │
            │  (or pending/{slug}/ if  │               │
            │   the site is unclaimed) │               │
            └───────────┬──────────────┘               │
                        ▼                              │
            ┌──────────────────────────┐               │
            │  Render Function         │               │
            │  sanitize HTML · WebP    │               │
            └───────────┬──────────────┘               │
                        ▼                              │
            ┌──────────────────────────┐               │
            │  Blob: rendered/{slug}/  │◄──────────────┘
            │  posts.json              │
            │  photos/*.webp           │   All containers PRIVATE.
            └──────────────────────────┘   No direct browser reads.
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

**Two shared addresses, accepted on all four domains.** There is no per-missionary ingest address — everyone everywhere is told to use the same two:

| Address | Verb | Who may use it |
|---|---|---|
| **`post@pdayletters.com`** | "Publish this letter." | Anyone. The classifier decides what's accepted. |
| **`claim@pdayletters.com`** | "I am this missionary; give me control of my site." | `@missionary.org` senders only, DMARC-verified. Everything else is ignored without reply. |

Both exist on `pdayemail.com`, `pday.email`, and `missionaryjournal.org` as well; `pdayletters.com` is the canonical form used in all instructions.

The target letters site is determined from **who wrote the letter**, not from which address received it — see [Sender-based routing](#sender-based-routing). The accepted-domain list is a Function app setting (`ACCEPTED_INGEST_DOMAINS`), not a config blob; it changes roughly never.

**Why two addresses rather than one?** `post@` and `claim@` express different *intents*, and separating them is what lets the `post@` path stay completely silent for missionaries. If a single address had to serve both, the system would have to infer intent — typically "reply if this sender isn't on the ACL yet" — which would send an unsolicited email to exactly the missionary whose parent is building a surprise site. An explicit address makes the request unambiguous and makes replying safe, because sending to `claim@` *is* the consent to be replied to.

This does not weaken sender-based routing. The recipient address selects a **verb**, never a **target**; the slug still comes entirely from the authenticated author, so there remains no attacker-supplied "which site" value.

**Why one address per verb instead of `{slug}@…`?** Three wins. (1) **Instructions get trivial** — "forward your missionary's email to `post@pdayletters.com`" works for every user of the service, with nothing to look up or personalize. (2) **It removes a whole class of security bug** — when the recipient address names the target site, the intake code must separately prove the sender is entitled to publish there, and getting that check wrong lets any missionary post to any other missionary's site. Deriving the target from the authenticated author makes the check structural rather than something we have to remember to write. (3) **No address provisioning at onboarding** — nothing to allocate, alias, or communicate when a new site is created.

**MX lives on the apex** of each domain, pointing at the inbound provider. This does not collide with outbound: sending happens from `no-reply@mail.pdayletters.com`, so bounce and delivery-event handling stay on the `mail.` subdomain and never touch the inbound parse path.

**Trade-off accepted:** a single well-known address attracts more spam than four semi-obscure per-missionary addresses did. Mitigated by the classifier (silent drop for any sender we can't tie to a site or to a valid claim), by the inbound provider's spam scoring, and by the fact that rejected mail never reaches `rendered/` and ages out of the intake quarantine in 30 days.

**Outbound mail is DKIM-signed as `pdayletters.com`, with the envelope sender on `mail.pdayletters.com`.** SPF/DKIM/DMARC are configured on `pdayletters.com` only, which keeps sender-authentication configuration simple. The visible `From:` differs by message type: **replies to inbound mail are sent from the address the sender wrote to** (`post@` or `claim@`) to preserve the recipient's prior-correspondence signal, while self-originated mail (day-7 reminders, ownership nudges) comes from `no-reply@mail.pdayletters.com`. DMARC passes either way through DKIM alignment. See [Ownership and the 60-day window](#ownership-and-the-60-day-window) for why this matters.

### Email ingestion

#### Message classification

Inbound messages fall into one of these classes based on what the intake code can verify. Only classified-as-accepted messages are written to `raw/`; everything else is dropped silently.

| Class | Detection | Publish? |
|---|---|---|
| `direct` | `From:` is `@missionary.org` and SPF/DKIM/DMARC all pass per `Authentication-Results`. The `From:` local-part **is** the target slug. | Yes |
| `forward` | The original message is recoverable (a `message/rfc822` attachment, or — **owners only** — inline forwarded text), its `From:` resolves to a known slug, and the forwarder is on that slug's ACL with a passing DMARC result of their own | Yes |
| `rejected` | None of the above — no recoverable `@missionary.org` author, or the forwarder isn't on the resolved slug's ACL, or authentication of the forwarder itself failed | No — drop silently, log to App Insights |

Provenance for `forward` messages is captured in an `extractionSource` metadata field for audit/debug: `rfc822` (embedded `.eml` was present) or `inline` (parsed from forwarded-text separators). The originating client (Gmail / Outlook / Apple Mail) and DKIM re-verify pass/fail are logged to App Insights at ingest time but not stored on the post — both can be re-derived from the preserved raw MIME if a specific extractor ever turns out to be buggy and we need to requery history.

Design principles:

- **Never trust the `From:` header alone.** Always require SPF/DKIM/DMARC pass on the outer envelope (for `direct`) or on the forwarder (for a `forward`).
- **The target site is derived from the letter's author, never from the recipient address** — see [Sender-based routing](#sender-based-routing). Every message goes to the same `post@` address, so there is no attacker-supplied "which site" input to validate.
- **The forwarder must be on the same ACL that grants them read access to the destination missionary's letters site.** There is no separate "allowed forwarders" list — access implies forwarding rights.
- **Inline-forward extraction is restricted to the `owner` role.** Text between forward separators is entirely forwarder-controlled and carries no cryptographic evidence of authorship — a `reader` could otherwise fabricate a letter, attribute it to the missionary, and backdate it anywhere in the timeline. Owners can already edit and delete any post, so allowing them inline forwards grants no privilege they don't have. `reader`-submitted forwards must carry a `message/rfc822` attachment ("forward as attachment"), whose DKIM signature can be re-verified against `missionary.org`.
- **Reject silently — unless the sender has proven they hold real missionary mail.** No bounce or error by default, because bouncing leaks which addresses exist and invites probing. The exception is a message carrying a **DKIM-valid `message/rfc822` original from `@missionary.org`**: that sender demonstrably possesses a genuine missionary letter, so they're a real person in the circle rather than a prober, and silence would leave them believing their forward worked. They get a short reply explaining what to do — see [Onboarding and auto-provisioning](#onboarding-and-auto-provisioning). Everything else is dropped without a word.
- **Log every rejection** to App Insights (sender, subject, reason, timestamp — no message body). Rejected messages are not archived to blob storage.

#### Sender-based routing

Messages to `post@` carry no routing information in the recipient — the address names a verb, not a destination. The target slug is resolved from **the author of the letter**:

| Case | Slug source |
|---|---|
| `direct` — missionary sent or BCC'd it themselves | Local-part of the outer `From:`, which DMARC has already authenticated |
| `forward` — someone forwarded a missionary's letter | Local-part of the **extracted original's** `From:` |

In both cases the author's address must be in `MISSIONARY_DOMAINS` — a Function app setting defaulting to `missionary.org` (see [Building blind](#building-blind)) — or an owner-registered alternate, and the local-part is used verbatim as the slug per [Missionary routing](#missionary-routing).

**Why this is safer than routing on the recipient.** When the recipient address names the target site, the intake code has to separately prove the sender may publish there — and if that check is missing or wrong, any authenticated missionary can publish to any other missionary's site. Deriving the target from the authenticated author collapses those two steps into one: there is no independent "target" value for an attacker to supply, so there is no mismatch to exploit.

**Forwards resolve to the author, not the forwarder.** A parent with two children serving, or an aunt on several families' ACLs, submits through the same address for all of them and the letters sort themselves out. It also fails safe in the interesting direction: if someone on Elder Smith's ACL forwards a letter written by Elder Jones, it routes to `elder.jones` and is rejected there for lack of ACL membership — rather than being mis-filed into Smith's site.

**BCC works unchanged.** Because routing never reads `To:` or `Cc:`, it makes no difference whether the address was on the `To:`, `Cc:`, or `Bcc:` line. This matters because BCC is the dominant pattern — missionaries put family in `To:` and the ingest address in `Bcc:` so relatives never see it, reply to it, or pass it around.

**Unresolvable messages.** If no `@missionary.org` author can be recovered — spam, a `reader` sending an inline forward, a mangled forward, a letter written from an unregistered personal address — the message is rejected silently and logged. Nothing is archived.

**Alternate sender addresses (deferred to Phase 6).** Some missionaries write from a personal account rather than `@missionary.org`, leaving routing nothing to key on. An owner-managed `alternateSenders` array in `profile.json` maps additional addresses onto the slug. Deferred because it requires the owner admin UI to exist first, and because `@missionary.org` covers the overwhelming majority.

#### Extracting and de-duplicating forwards

Because anyone on a missionary's ACL can forward historical email, the intake code has to extract the "true" original message and check whether we already have it — while being tolerant of the small variations email trips through (quoted-reply prefixes, stripped signatures, MIME re-encoding, missing attachments, minor date/time-zone drift).

**Extract the original:**

1. **Prefer `message/rfc822` attachments.** Outlook, Apple Mail, and Gmail's "forward as attachment" all embed the original as an rfc822 MIME part with headers intact.
2. **Fall back to inline forwards.** Parse blocks starting with `---------- Forwarded message ---------` (Gmail), `Begin forwarded message:` (Apple Mail), or `-----Original Message-----` (Outlook). Extract original `From`, `Date`, `Subject`, and body text.
3. **Associate outer-message attachments with the extracted original** in the inline case (webmail forwards typically re-attach photos to the outer message rather than embedding them in the inline block).

**Match key priority:**

1. **Exact match on original `Message-ID` header** — extracted from the embedded `.eml` when available. A hit here is a certain match; stop and treat as duplicate.
2. **Gated exact-text match** — when no `Message-ID` is available (inline forwards, some hosts strip it).

**Hard gates (must both match, exactly):**

- `originalFromLower` — exact string equality (both sides lowercased). Sender is a hard identity signal; two messages from different missionary accounts are never duplicates of each other.
- `originalDateDay` — exact `YYYY-MM-DD` equality on the calendar day of the original `Date:` header, **evaluated in the offset carried by that header itself**, not converted to UTC. Missionaries write from wildly different time zones and the header's own offset is the one value every copy of a given message preserves.

The bucket query is an in-memory scan of the missionary's already-loaded `posts.json`: filter posts whose `originalFrom` matches (case-insensitively) and whose `originalDate` day matches. Typically returns **0–2 candidates**.

**Decision (only for candidates that pass both gates):** it's a duplicate if **either** normalized field matches exactly.

| Field | Normalization |
|---|---|
| `subjectNormalized` | Iteratively strip leading `Re:` / `Fw:` / `Fwd:` tokens **and** any `[…]` bracketed prefix (e.g. `[EXTERNAL]`, `[SPAM]`) until neither pattern matches; collapse internal whitespace; lowercase. |
| `bodyHead100` | Strip quoted-reply lines (`^>`), strip signature blocks (from `-- \n` or the first `Sent from my …` line onward), collapse whitespace, lowercase, take the **first 100 characters**. |

No similarity scoring, no weights, no threshold.

**Why exact match rather than fuzzy scoring.** Weighted similarity scoring (Jaro–Winkler over normalized subject and body, with a tuned cutoff) would be solving a problem the hard gates have already eliminated. Missionaries write **once a week**; after requiring an exact sender match *and* an exact calendar-day match, the candidate set is almost always empty, and when it isn't, the two messages are either byte-similar re-forwards of one letter (both normalized fields match trivially) or genuinely different messages sent the same day — a second letter with more photos, say — where subject and opening line differ obviously. There is no realistic middle ground for a similarity score to adjudicate, so weights and a threshold would be tuning knobs with nothing to tune against. Exact matching is a fraction of the code, has no calibration surface, and fails in the safe direction: a missed duplicate is a visible extra post an owner can delete in one click, whereas a false positive silently swallows a real letter.

**Upgrade path.** Raw MIME is archived permanently, so if real-world data ever shows duplicates slipping through, we can reintroduce scoring and re-run it across all history without asking anyone to resubmit.

**Storage of truth.** Dedup does not use a separate Azure Table. `rendered/{slug}/posts.json` already contains every field the check needs (`originalMessageId`, `originalFrom`, `originalDate`, `subject`, `bodyText`), so ingest just loads that blob and scans it in memory. `subjectNormalized` and `bodyHead100` are computed on the fly against the 0–2 candidates that pass the sender+date gate — cheap enough that precomputing and storing them buys nothing.

**Concurrency.** A parent bulk-forwarding several weeks of missionary emails in quick succession is an entirely normal usage pattern, so ingests for a single slug can arrive in bursts. Handled with **optimistic concurrency on `posts.json`**:

1. Ingest loads `posts.json` and records its ETag. (On the very first message for a slug the blob doesn't exist yet — write with `If-None-Match: *` so two simultaneous first messages can't both create it.)
2. Runs the dedup check against the loaded posts.
3. If duplicate: send the courtesy ack, done. Nothing written to `raw/` or `rendered/`.
4. If new: append the post skeleton in memory, `PUT` back to blob with `If-Match: <etag>`, then write `raw/{slug}/{msgId}/`, then enqueue render.
5. On `412 Precondition Failed` (a sibling ingest committed between our load and our write), restart at step 1. On the retry the newly-committed sibling post is now visible, so if it *was* a duplicate of ours we'll correctly ack instead of appending.

`raw/` is only written after the ETag write succeeds, so a lost race never leaves an orphaned raw folder to clean up. At weekly-per-missionary cadence — even with occasional 5–10-message bulk-forward bursts — collisions are infrequent and each retry is cheap (one JSON fetch + one hash compare). If contention ever becomes measurable we can move to a blob lease for stricter serialization, but the optimistic path is expected to hold for a long time.

**On dedup hit:** don't create a new post. Send a courtesy acknowledgment reply (see [Notification preferences](#notification-preferences)) unless suppressed for that user. We deliberately do not track who else has forwarded a given message — the courtesy reply is the only outward signal, addressed to the current forwarder alone. A `who-forwarded-what` history would be data we collect but never use.

**Post ordering:** posts are sorted by the **original `Date:` header**, not `receivedAt`. Forwards land in their correct historical position in the timeline. `receivedAt` is retained on each post for audit and for a "Recently added" ribbon in the reader UI.

### Email ingestion — SendGrid Inbound Parse

**Decision: SendGrid Inbound Parse.** The alternative considered was Logic Apps polling an M365 shared mailbox. SendGrid wins on the plan's "minimal moving parts" goal by a wide margin — one webhook versus a Logic App plus Graph API auth plus tenant accepted-domain configuration plus alias management. See [docs/email-options.md](email-options.md) for the full vendor comparison.

**Setup:** MX records on the apex of each of the four accepted domains point at SendGrid. Inbound Parse supports multiple hosts on a single account, all delivering to one webhook. SendGrid POSTs a parsed multipart form (headers, text, HTML, attachments, spam score) to a single HTTPS Function endpoint.

#### The webhook must be almost too dumb to fail

SendGrid Inbound Parse retries a failing webhook for a limited window and then **discards the message permanently**. There is no mailbox holding a copy. That directly threatens the "preserve everything, exactly as received" goal — an outage or an unhandled parser exception is unrecoverable data loss, and the sender gets no indication anything went wrong.

So the webhook does exactly two things and nothing else:

1. Write the raw POST body verbatim to `raw/_inbox/{ulid}.raw`.
2. Enqueue `{ulid}` on the ingest queue.

Then return `200`. No parsing, no classification, no slug resolution, no ACL lookup, no dedup, no `posts.json` read, no outbound email. All of that happens in a **separate queue-triggered ingest Function** where a failure is retried from durable storage and eventually dead-lettered for inspection rather than lost.

This inverts the usual failure mode: the only way to lose a message is for Blob Storage itself to be unavailable, and the only code that can throw is a blob write. Everything with real logic in it — MIME parsing, forward extraction, DKIM re-verification, the classifier — runs against data we already hold.

**Consequences worth noting:**

- `raw/_inbox/` accumulates payloads for messages that are ultimately rejected. A lifecycle rule deletes `_inbox/` blobs after 30 days; accepted messages are copied into `raw/{slug}/{msgId}/` by the ingest Function and are unaffected.
- Rejected mail therefore *is* briefly on disk. This is a deliberate trade: 30 days of quarantined spam in a private container is a much smaller cost than permanently losing a real letter to a parser bug.
- Message size ceiling is SendGrid's 30 MB. Gmail caps outbound attachments at 25 MB, so Gmail senders hit their own limit first. A message rejected at the SMTP layer for size never reaches the webhook — the sender gets a normal bounce from their own provider, which is the correct behavior and requires nothing from us.

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

**The site root is public.** `pdayletters.com/` serves an unauthenticated landing page — what the service does, the `post@pdayletters.com` address, and *"Are you a missionary? Email `claim@pdayletters.com` from your `@missionary.org` address to claim your site."* Everything on it is generic; no slug, no name, no content. Without it there is no way to discover `claim@` at all, since every letters site is auth-gated and the `post@` path is deliberately silent.

**Signed in, the root redirects instead.** A visitor with an authenticated session goes straight to the most recently updated site they belong to; from there the [site switcher](#switching-between-sites) reaches any others. A signed-in user with *no* memberships gets a short explanation rather than the marketing page: *"You're signed in as jane@example.com, but that address doesn't have access to any letters site yet. Ask whoever set it up to invite this address."* That message earns its place — the likeliest support question this service will ever get is someone invited at one address signing in with another, and it answers that question without a human involved.

### Ingest address scheme

There is one ingest address, `post@pdayletters.com`, plus the same local-part on the three alternate domains (see [Domains](#domains)). It is identical for every user of the service and appears verbatim in all instructions. Nothing is allocated or communicated per missionary.

The target site is resolved from the letter's author via [Sender-based routing](#sender-based-routing), so the recipient address carries no routing information at all — it exists only to get the message to us.

**Why not per-missionary addresses.** Two alternatives were considered and rejected: `{slug}@ingest.{domain}`, and `{slug}-{4-char-token}@…` for unguessability. The token adds nothing — the classifier already rejects anything that isn't a verified `direct` or an ACL-member `forward`, so obscurity buys no defense while costing an ugly address, a `profile.json` field, extra parser logic, and a rotation UI. The per-missionary address is rejected for a stronger reason: encoding the target site in an attacker-supplied field means the code must separately prove the sender is entitled to publish there, and that check is exactly the kind of thing that gets forgotten. Deriving the target from the authenticated author removes the input rather than validating it.

### Storage layout

Single storage account, cool-tier by default (photos rarely re-read after posting).

```
raw/                                   Preserved archive. Write-once by
  _inbox/                              convention; container-level
    {ulid}.raw                         soft-delete + versioning enabled.
                                       Verbatim webhook payloads awaiting
                                       processing. 30-day lifecycle rule.
  {missionary-slug}/
    {msgId}/
      message.eml                      Full raw MIME
      attachments/
        {nn}-{safe-name}               Originals, byte-for-byte (EXIF intact).
                                       Path segment is sanitized; the true
                                       filename lives in metadata.json.
      metadata.json                    ingested-at, extractionSource,
                                       original filenames, headers subset

pending/                               Unclaimed sites. Raw only — never
  {missionary-slug}/                   rendered. Purged after 60 days of
    claim.json                         inactivity (14 if forward-only).
    {msgId}/ …                         Same shape as raw/{slug}/

rendered/                              Rewritable. Regenerated by render function.
  {missionary-slug}/                   Sanitized HTML only — never raw email HTML.
    posts.json                         Array of published post objects
    photos/
      {photo-id}/                      photo-id is a content hash — see below
        large.webp                     ~2400px longest edge (post + full-screen)
        thumb.webp                     ~400px for album grid

config/
  {missionary-slug}/
    profile.json                       Display name, alternateSenders,
                                       returnDate (optional)
    acl.json                           Email allowlist + roles, incl.
                                       verifiedMissionary flag
```

Plus one **Storage Queue** (`ingest`) carrying `_inbox` ULIDs from the webhook to the ingest Function, and one (`render`) carrying accepted `{slug}/{msgId}` pairs to the render Function.

**Attachment filenames are never used as path segments.** Blob names are flat strings in which `/` creates virtual directories, so a crafted filename like `../rendered/elder.smith/posts.json` would escape the intended prefix and overwrite live data. Each attachment is stored as `{nn}-{safe-name}`, where `nn` is its MIME part index and `safe-name` is the original filename stripped of path separators, `..` sequences, control characters, and leading dots, then truncated. The unmodified original filename is recorded in `metadata.json`, so nothing is lost for display or export. The same sanitization is reapplied when building the offline zip — otherwise the identical bug reappears as zip-slip on the user's own machine.

**Photo IDs are content hashes** — `p_{sha256(bytes)[:12]}`. This is what actually makes the render function idempotent: a re-run produces identical IDs and overwrites identical blobs instead of orphaning the previous set. It also dedupes repeated images for free (mission logos, a photo the missionary resends), which shrinks both storage and the offline export.

Plus two Azure Tables in the same storage account:

- **`users`** — `PartitionKey = "user"`, `RowKey = lowercased email address`. Identity columns: `displayName`, `authProvider` (`google` | `microsoft`), `firstSeenAt`, `lastSignInAt`. Preference columns: `postAckEmails` and `dedupeAckEmails` (bools — see [Notification preferences](#notification-preferences) for the per-sender-type defaults); additional per-user preferences are just additional columns as they arrive. State columns: `claimEmailSentAt` and `claimEmailCount`, driving the tapering re-invitation schedule for a missionary whose own letters created a pending site — kept here rather than in `claim.json` so the schedule survives a pending-site purge and recreation.
- **`memberships`** — `PartitionKey = lowercased email address`, `RowKey = slug`. Columns: `role`, `missionaryDisplayName`, `addedAt`, `lastPostAt`. Answers *"which sites does this person belong to?"* in one partition query. Without it that question requires opening `config/{slug}/acl.json` for every missionary in the service, because ACLs are stored per-slug with no reverse index.

**`memberships` is a derived index, never the authority.** `acl.json` remains the source of truth and is what the content API checks on every request. The table is dual-written on invite, revoke, and claim, and can be rebuilt by scanning `config/*/acl.json` if it ever drifts. That ordering matters: a bug in the index produces a missing or stale entry in a switcher menu, never a wrong access decision. `lastPostAt` is denormalized from render for ordering — a fan-out write bounded by the size of one ACL, which is a handful of family members.

No separate deduplication table — `rendered/{slug}/posts.json` is the dedup source of truth (see [Extracting and de-duplicating forwards](#extracting-and-de-duplicating-forwards) for the scan + concurrency model).

### Data model (posts.json entry)

```jsonc
{
  "id": "2020-07-06-a7f3",
  "extractionSource": "rfc822",             // direct | rfc822 | inline
  "originalDate": "2020-07-06T18:04:22-04:00", // original Date: header, offset preserved; drives sort order
  "receivedAt": "2026-07-25T12:14:00Z",     // when this ingestion actually happened
  "subject": "Week 34 - miracles in Manaus",
  "bodyHtml": "<p>…</p>",                    // SANITIZED at render time — never raw email HTML
  "bodyText": "…",
  "originalMessageId": "<CAB=…@mail.missionary.org>",  // dedupe key when available
  "originalFrom": "elder.smith@missionary.org",
  "photos": [
    { "id": "p_9a2c3f81b447", "width": 4032, "height": 3024 }
  ],
  "sourceRawPath": "raw/elder.smith/{msgId}/message.eml"
}
```

The original `Date:` header keeps its offset rather than being normalized to UTC. Missionaries write from all over the world, and the local calendar day is both the value the dedup gate keys on and the one readers actually mean when they say "the letter from the 6th."

**No `ingestDomain` field.** An acknowledgment email could name the address the sender wrote to, but acks are composed at ingest time when that value is already in hand, so storing it on the post buys nothing. It's logged to App Insights instead, matching how client type and DKIM results are handled.

### Content sanitization

Email HTML is untrusted input. Under the `forward` path it is, by construction, supplied by a third party. Rendering it unmodified in an authenticated page would be a stored-XSS vector — and because Static Web Apps authenticates API calls with a session cookie, script running on a letters page could add ACL members, edit posts, or pull down the whole archive. This is the single most important control in the system.

- **Sanitize at render time, not display time.** The render Function runs an allowlist-based sanitizer (`sanitize-html` / DOMPurify) over the message HTML and writes only the sanitized result into `rendered/`. The reader UI never handles raw email HTML at all, so a bug in the reader can't reintroduce the vulnerability, and the offline export and the print-book PDF inherit the same sanitized content for free.
- **Allowlist, never denylist.** Permit the small tag set letters actually use — headings, paragraphs, breaks, lists, emphasis, blockquote, links, images — and drop everything else. No `<script>`, `<style>`, `<iframe>`, `<object>`, `<form>`, no `on*` handlers, no `style` attributes, no `javascript:` / `data:` URLs.
- **Rewrite `cid:` image references.** Most rich mail embeds photos as `<img src="cid:…">` pointing at MIME parts rather than attaching them separately. These must be rewritten to the corresponding rendered photo URL during sanitization or embedded images silently break — a common case in Outlook and Apple Mail, not an edge case.
- **Strip remote images entirely.** Any `<img>` still pointing off-site after `cid:` rewriting is removed. These are overwhelmingly tracking pixels, and leaving them in would leak every reader's IP address and read time to whatever marketing system the missionary's email passed through. Legitimate photos are always attachments or `cid:` parts, so nothing of value is lost.
- **Defense in depth:** serve a strict `Content-Security-Policy` (no `unsafe-inline`, no external script origins) so that a sanitizer bypass still has nowhere to execute.
- **The unsanitized original is never destroyed.** It stays in `raw/`, so if the sanitizer is later found to be stripping something it shouldn't, history can be re-rendered.

### Private content delivery

"Private by default" is a headline goal, but Static Web Apps authentication does not extend to Azure Blob Storage. If `rendered/` were a public container, every letter and photo would be readable by URL regardless of any ACL. All private content therefore flows through the API:

```
/api/content/{slug}/posts.json
/api/photo/{slug}/{photoId}/{size}.webp
```

All blob containers are private, with public access disabled at the account level. The Function reads the caller's identity from the `x-ms-client-principal` header that Static Web Apps injects into every API request, checks it against that slug's `acl.json`, and streams the blob.

**Why this rather than SAS tokens.** Because SWA injects the authenticated principal, the Function performs no token validation of its own — base64-decode a header, read an email address, check a list. There is no SAS to mint, no expiry to track, no client-side refresh logic, no CORS configuration, and no bearer token that can be forwarded to someone off the ACL. At this volume the extra hop costs effectively nothing: a page view pulling ten ~300 KB WebP renditions moves ~3 MB through a Consumption Function, and responses carry `Cache-Control: private, max-age=3600` so repeat views are served from the browser cache.

**Upgrade path, if it's ever needed.** If egress through Functions or added latency ever shows up in telemetry, swap to a **user-delegation SAS** scoped to `rendered/{slug}/` and minted once per session after the same ACL check. Bytes then come straight from Blob Storage. Deliberately not built now — it trades real complexity for performance nobody has asked for.

**Private content delivery is Functions-mediated, and Functions on Consumption scale to zero.** The first API call a reader makes after sign-in is `/api/content/{slug}/posts.json`, which pays a ~1–3 s Node cold start on a site nobody has visited for a while. Photos are unaffected — they can't be requested until `posts.json` has returned, by which point the app is warm. Static Web Apps authentication is handled by the SWA platform rather than by a managed Function, so signing in does *not* pre-warm anything; `posts.json` is the warm-up. Given a weekly visit cadence this is acceptable, and `Cache-Control: private, max-age=3600` keeps repeat views off the Function entirely.

**Standard tier does not, on its own, fix this.** Supporting Google auth forces Standard (custom identity providers aren't available on Free), but SWA *managed* functions still run on Consumption at any tier — Standard raises limits, it doesn't add always-ready instances. What Standard buys is the **escape hatch**: it permits a linked backend, so the API can be moved to a separately-deployed Function App on Flex Consumption with always-ready instances if telemetry ever justifies the extra resource and cost. Before that, the cheap fix is a 5-minute timer-triggered ping, which keeps one instance alive within the free grant.

**The offline export is unaffected.** It's an owner- or reader-initiated download of content they're already entitled to, packaged as plain files.

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

**Client-side MiniSearch, index built in the browser.** The reader fetches `posts.json` and calls `addAll(posts)` on load. There is no prebuilt index artifact.

**Why no prebuilt `search-index.json`.** A serialized MiniSearch index stores the inverted index *plus* the stored fields, so it is typically **larger than the source text it indexes** — and the reader still needs `posts.json` to display anything, so emitting one would ship roughly twice the necessary bytes. Skipping it also avoids an artifact, a build step, a file to keep in the export bundle, and a class of staleness bug: the post-edit path in Phase 5 would have to rebuild the index or leave edited posts unsearchable by their new text.

**Size in practice.** A full two-year mission is ~104 letters at roughly 500–1500 words each — about 1.5 MB of JSON, or **~250–350 KB compressed**, comparable to a single photo. Indexing that many documents takes milliseconds. In exchange, list rendering, post navigation, and search all become instant with no further round-trips, and the same code path works offline in the exported archive.

**If first paint ever needs to be faster**, the fix is to split by payload role rather than reintroduce an index: emit an `index.json` of id, date, subject, snippet, and thumbnail id (~8 KB compressed) for immediate list rendering, and fetch `posts.json` in the background to enable search a moment later. Not built now — revisit if `posts.json` exceeds ~5 MB uncompressed or if measured first paint on cellular is poor.

### Access control

- **Auth:** Static Web Apps **Standard** with Google and Microsoft identity providers. **Google is required, not optional** — `@missionary.org` is Google Workspace, so the missionary population is Google-native, and personal Gmail is the most likely identity for the family members around them too. Google is a *custom* provider in SWA, which is available only on Standard; that tier was already the plan's baseline for other reasons, so this adds no cost.
- **Model:** per-missionary allowlist keyed on the authenticated user's email address.
- **Roles per missionary's letters site:**
  - `owner` — full admin rights: invite, revoke, add/remove other owners, and edit/hide/delete any post (including editing the subject or body — for copy-editing, retroactive anonymization of names or locations, or fixing typos after publication). **Multiple owners allowed** so the missionary can share admin duties (typically with a parent) without a separate role tier. There is always at least one owner — the "remove owner" action refuses if it would drop the count to zero.
  - `reader` — invited viewer. Read-only for site content; can also download the offline archive and order a printed book for themselves (see [Post-mission archive](#post-mission-archive) and [Journal Publish](#journal-publish)).
- **`verifiedMissionary` owners cannot be removed by others.** An owner entry created through the `claim@` flow (see [Ownership and the 60-day window](#ownership-and-the-60-day-window)) carries this flag and is removable only by that owner themselves. It's the tiebreaker that makes a genuine ownership dispute resolvable instead of a race.
- **Owners on `missionary.org` are warned continuously.** Any owner identity on that domain stops working 60 days after the missionary returns home, so the admin UI shows a persistent banner until a non-`missionary.org` owner exists.
- **Invitations:** an owner enters one or more email addresses and a role; each is added to `acl.json` **and sent an invitation email carrying a signed link**, and access binds to whatever identity accepts through that link. See [Invitations](#invitations).
- SWA route rules enforce that `/{missionary-slug}/*` requires an authenticated user whose email is in that slug's ACL. API calls check the same ACL server-side.
- **Forwarding is gated by the same ACL.** Anyone on a missionary's ACL can forward historical missionary emails to `post@pdayletters.com` and have them land on that missionary's site.
- **Inline forwards are owner-only.** A forward whose original arrives as a `message/rfc822` attachment carries verifiable DKIM; an inline forward is just text the forwarder typed and could have edited or fabricated. Readers can forward, but only an owner's inline forward is accepted for publication — matching the fact that owners can already edit any post's body anyway, so the restriction grants them nothing new.

#### Invitations

**An invitation is an email, not just an ACL write.** Adding an address to `acl.json` grants access but tells nobody; without a message, the invitee can reach the site only if the owner separately sends them the URL.

**Adding people is bulk by default.** The realistic first act after claiming a site is inviting a dozen relatives in one sitting, so the field accepts a pasted list — commas, semicolons, newlines, and `Name <addr@example.com>` forms — rather than one address at a time. One-at-a-time entry turns the single most common setup task into a dozen round-trips through a confirmation dialog.

**Each invitee gets exactly one email**, self-originated from `no-reply@mail.pdayletters.com` (see [Domains](#domains)) — the only class of outbound mail the service sends to someone who never wrote to us. Three things make that acceptable, and all three are requirements rather than niceties:

- **It names the human who invited them**, in the subject and the first line: *"Sarah Smith invited you to read Elder Smith's letters."* Unattributed, it is a message from an unfamiliar domain, about a named person, asking you to click a link — a very good impression of phishing.
- **It is never repeated.** No reminders, no nudges. An unaccepted invitation stays unaccepted. Anything else turns a text box on a web page into a mechanism for repeatedly mailing arbitrary strangers.
- **It carries the one-click opt-out** already built for acks, which here means "never invite me to anything again" and is honored ahead of any future invitation to that address.

**The link is a signed invitation token, and that token — not the typed address — is what grants access.** Same HMAC mechanism as the claim link, scoped smaller: single-use, bound to one slug and one role, 30-day expiry.

It exists because the ACL is keyed on email address, but **the address an owner knows for someone is frequently not the address behind their Google or Microsoft account.** A parent invites `grandma@aol.com`; Grandma signs in with the Gmail account her tablet set up years ago; the ACL check fails; she is locked out of a site she was just invited to, and neither she nor the parent can see why. Multiply by every relative with a work address, an old ISP address, or a shared household mailbox.

Binding on acceptance avoids that entirely: whatever identity signs in *through the invitation link* is written to the ACL. The typed address is **where to send the invitation**, not **who the person must prove they are**. Both are recorded — `invitedEmail` alongside the bound identity — so the owner's list still shows the address they typed.

**The security trade is small and consistent with the claim link.** A forwarded invitation email lets the recipient in — the same property the claim link has, at lower stakes, since the claim link grants ownership of the whole site while an invitation grants read access to letters the forwarder could already read. Single-use binding caps exposure at one identity, and an owner can revoke.

**ACL entries carry an acceptance state** — `invited` (no identity bound yet) or `active` — surfaced in the owner's admin list, so *"Grandma says she still can't see it"* is answerable by looking: the owner sees the invitation was never accepted and resends, which issues a fresh token and invalidates the old one. **A resend is owner-initiated and manual**, which is what keeps "never repeated" true — the service never decides on its own to email an invitee a second time.

#### Signed in, but not on the list

A valid session on a site you don't belong to is a `403`, and it needs different handling from the expired-session `401` above: signing in again does not help, because the problem isn't *that* you're signed in but *which* account you're signed in as. It covers the mismatched-address case above, a revoked reader following an old bookmark, and someone opening a link that got forwarded around a ward.

The page names the identity being rejected and what to do about it: *"You're signed in as `grandma.smith@gmail.com`, but that address doesn't have access to Elder Smith's letters. If you were invited at a different address, sign out and sign in with that one — or ask whoever invited you to add this address."* A **Sign out and try another account** button points at `/.auth/logout` with a redirect back to the same path.

Naming the signed-in address is what makes the page useful — without it, "wrong account" and "not invited" look identical, and they have opposite remedies. The missionary's display name appearing here to an unauthorized visitor is a deliberate and very small disclosure: they already hold the slug, which is the missionary's own email local-part, so the name is not news.

#### Switching between sites

A grandparent with two grandchildren out, or a friend of several missionaries, belongs to more than one ACL. **There is deliberately no dashboard page.** A portal you pass through on every visit is worse than the thing it indexes, and for the overwhelming majority — who have exactly one site — it would be pure friction between them and the letters.

Instead the site header carries a **switcher, rendered only when the signed-in user has more than one membership**, listing the other missionaries by display name as direct links. One membership and nothing appears at all; the UI is exactly as it is today. Populated from a single `memberships` partition query (see [Storage layout](#storage-layout)).

Together with the signed-in root redirect (see [Missionary routing](#missionary-routing)) this makes discovery complete without adding a page: land on any site you belong to, reach all the others from there. Both pieces are necessary — every site is auth-gated and the root is generic to anonymous visitors, so a reader who loses the URL otherwise has no way back in.

#### Sessions expire, and re-authenticating must be invisible

Static Web Apps issues its own session cookie at the edge; the app never sees a token, only the decoded `x-ms-client-principal` header. **Its lifetime is not configurable and Microsoft doesn't publish it** — it is commonly observed at around eight hours. Plan for "about a working day," and design so the exact number doesn't matter.

**MSAL is not a lever here.** SWA managed authentication is platform-level and server-side, with no hook for extending or refreshing the session. Reaching for MSAL would mean abandoning SWA auth entirely and validating tokens inside every Function — which forfeits the central simplification behind [Private content delivery](#private-content-delivery), where the API performs no token validation of its own. Not worth it to lengthen a session.

So the answer is not a longer session, it's making the return trip cost one click. Two flows, because expiry surfaces in two different places:

- **A deep link — the case that matters most.** Family members reach their letters site by bookmark or by a link someone texted them, so an expired session lands on `/{slug}` and, with no handling, yields a bare `401`. A [`responseOverrides`](https://learn.microsoft.com/azure/static-web-apps/configuration#response-overrides) rule on `401` redirects to the sign-in chooser carrying `post_login_redirect_uri=.referrer`, so after signing in they arrive at the page they originally asked for.
- **The root page.** `/` is anonymous-allowed, so an expired session simply sees the public landing page rather than being redirected — correct behavior, since it's also what a genuine stranger must see. It therefore needs a visible **Sign in** button, pointing at the chooser with `post_login_redirect_uri=/`. Sending them back to the *root* rather than to a site is deliberate: root already knows how to resolve a signed-in visitor to their most recent site, so the destination logic lives in exactly one place and can't drift.

**Sign-in is a chooser page, not a direct provider link.** SWA sign-in routes are provider-specific (`/.auth/login/google`, `/.auth/login/aad`), and with two providers there is nothing sensible to guess — picking wrong strands a user on an account that isn't on any ACL. A small `/login` page presents both buttons and threads `post_login_redirect_uri` through to whichever they choose. **Verify during Phase 5** that SWA's `.referrer` substitution survives the hop through an intermediate page; if it doesn't, the 401 override can capture the original path itself and pass it explicitly.

### Onboarding and auto-provisioning

There is no signup form. A site comes into existence because someone mailed us a letter.

**The instruction is one sentence:** *forward your missionary's email to `post@pdayletters.com` and follow the instructions you get back.* That works whether the missionary sends it themselves or a parent forwards one they received, which matters — missionaries have very little P-day computer time, and asking them to complete a setup flow is exactly the friction this service exists to remove.

#### States

| State | Meaning |
|---|---|
| **pending** | Messages have arrived for a slug that has no site yet. Raw MIME is stored under `pending/{slug}/`. **Nothing is rendered and nothing is viewable.** |
| **active** | Someone has claimed the site and become its first owner. Normal operation. |
| *(purged)* | Unclaimed, with no new letter for the full retention window — **60 days** once any `direct` message has arrived, **14 days** while the site is forward-only. Everything is deleted. |

#### Flow

1. A message arrives at `post@pdayletters.com`. Sender-based routing resolves a slug from the letter's author, but no site exists for it.
2. Create `pending/{slug}/` with a `claim.json` (slug, `createdAt`, `lastMessageAt`, `expiresAt`, `hasDirect`, a **hash** of the claim token, list of addresses already emailed) and store the raw message. **No rendering, no `posts.json`, no photos.** Only the hash is stored, so read access to the blob doesn't confer the ability to claim.
3. **Send a claim email — only ever to the person who wrote to us.** Two variants:
   - **A forwarder** gets: *"We received a letter from Elder Smith. Click here to set up his letters site."*
   - **The missionary themselves**, when the message is `direct` — they added `post@` to their own BCC line — gets an invitation with the same claim link and an explicit suggestion: *"If you'd rather not manage this, forward this email to a parent. They can click the link, run the site, and you can just keep BCC'ing `post@` every week without thinking about it again."* Repeated on a tapering schedule until the site is claimed — see [Re-inviting the missionary](#re-inviting-the-missionary).
4. Further messages for the same pending slug are **accumulated silently**, and each one **resets `expiresAt`** from its own arrival. A parent can dump twenty old emails in one sitting without getting twenty claim emails. A claim email goes to at most one address per unique forwarder and at most three per pending site; the missionary's invitations are separate from and additional to that cap.
5. **Claim.** The link opens `pdayletters.com/claim/{token}`, and that page is **anonymous-allowed on purpose.** An auth-gated claim route throws a Google consent screen at someone whose only context is an email they just opened — alarming, and it explains nothing. So the page leads with what is being claimed: the missionary's name, the counts (*"7 letters and 31 photos from Elder Smith are waiting"*), a few subject lines and dates so it is self-evidently the right person, and a plain statement of what happens next — *you'll sign in, and you'll be the person who runs this site.* Only then the **Sign in with Google / Sign in with Microsoft** pair, each threading `post_login_redirect_uri` back to this same `/claim/{token}` URL so the token survives the OAuth round trip.

   On return the Function validates the token, writes the signed-in identity into a new `config/{slug}/acl.json` as the first `owner`, and asks for **one setup field: the missionary's display name**, pre-filled from the `From:` display name on the letters already in hand. It is the only thing the site cannot infer, it appears throughout the UI and on the book cover, and collecting it here is far cheaper than a settings page nobody visits. Everything else is already determined. Submitting lands them on the site itself — promotion (step 6) was enqueued at claim, so a large backlog may still be rendering; the site shows what it has and fills in as renders complete.

   **Expired and already-used links.** The token shares the pending site's rolling `expiresAt`, so it lives exactly as long as there is something to claim — a shorter fixed clock would strand a claimant while the letters sit intact. The failure page still does something useful: if the site is now active, *"This site is already set up"* plus a sign-in link, letting the ACL decide; if the pending site has purged, say so plainly; if the token is merely stale or spent, offer **"Email me a new link"** — which sends only to an address already listed in `claim.json` as previously emailed, so the button cannot be used to mail anyone new.
6. On claim, everything accumulated is moved to `raw/{slug}/` and enqueued for render **in `originalDate` order, running dedup for the first time** — so a bulk dump of forwards comes out deduplicated and chronologically ordered in a single pass, with no interim half-built site for anyone to see. **Promotion suppresses post-published acks.** A parent who forwarded seven weeks of letters and just clicked the claim link is looking at those seven letters on screen; seven emails telling them so would arrive seconds later and answer a question the site has already answered. Dedupe acks are suppressed here too, for the same reason — the promotion pass is the first time dedup has ever run for this slug, so any duplicates it catches are ones the forwarder submitted before there was anything to compare against.
7. **Reminder and purge.** One reminder per pending site goes to the forwarder addresses already emailed, seven days after the *first* claim email for that site — keyed to the site, not to each individual claim email, so three forwarders don't produce three reminders on three clocks. **It reports what's waiting:** *"We're holding 7 letters and 31 photos for Elder Smith. Nobody can read them yet — click here to finish setup."* This is also the only confirmation a bulk forwarder ever gets that anything past their first message arrived, since forwards into a pending site are otherwise accumulated silently. Counts come from the pending folder, so they're accurate at send time. When `expiresAt` passes with no intervening message, a timer-triggered Function purges `pending/{slug}/` entirely, including soft-deleted blob versions.

#### Re-inviting the missionary

A single invitation is too few. Picture a missionary who adds `post@` to his BCC line, skims the reply on a busy P-day, and never acts on it. The rolling window means nothing is lost — but six months later there are twenty-six letters sitting unrendered and unviewable, his family has read none of them, and his only contact from us was one message half a year ago. He believes it's working. It is, in the sense that everything is preserved; it isn't, in the sense that no site exists.

So the invitation repeats, on a **tapering schedule, always as a reply to an actual letter**:

| Invitation | Sent with the first `direct` letter arriving… |
|---|---|
| 1st | immediately — the message that created the pending site |
| 2nd | ≥ 30 days after the previous invitation |
| 3rd | ≥ 90 days after the previous invitation |
| 4th and later | ≥ 180 days after the previous invitation |

Two properties matter more than the exact numbers:

- **Never on a timer.** An invitation is only ever sent *in response to an inbound letter*. It is always a reply to a message the missionary just sent, which keeps the solicited-reply deliverability argument intact (see [Ownership and the 60-day window](#ownership-and-the-60-day-window)) and guarantees we never mail someone who has stopped using the service. If letters stop, the invitations stop with them.
- **Tapering, not periodic.** Widening intervals catch the person who missed the first without becoming the recurring interruption the design works hard to avoid. Across a two-year mission this is at most five or six messages total.

**Every invitation after the first reports what's waiting.** This is the part that actually converts, because it makes the cost of inaction concrete rather than abstract: *"We've saved 14 letters and 63 photos from you. Nobody can read them yet — finish setup, or forward this to a parent, and your family gets all 14."* The counts come from the pending folder, so they're accurate and they grow every week that nothing happens.

**Tracked as `claimEmailSentAt` and `claimEmailCount`** on the missionary's `users` row — not in `claim.json`, so the schedule survives a pending-site purge and recreation. On claim, both stop mattering; on an active site the missionary hears nothing at all.

#### The retention window is rolling, and it upgrades

The window has two properties, and both matter:

- **Rolling, not fixed.** Every message for a pending slug resets the clock, so the window measures *inactivity*, not age. A site receiving weekly letters never expires — an arriving letter is fresh evidence the slug is real and in use. A fixed window measured from the first message would instead delete a bootstrapping missionary's letters on day 14, start a fresh clock on the next letter, and lose those too, indefinitely and silently, while he believed it was working.
- **The window depends on what we can prove.** A `forward`-created pending site rests on a stranger's assertion and keeps the short 14-day fuse. A `direct` message is DMARC-verified mail from the missionary's own account — definitionally not spam — and raises the window to **60 days**. The upgrade is sticky: once `hasDirect` is set it never reverts, even if later messages are forwards.

The 14-day fuse exists to stop junk from accumulating pending sites forever, which is why it applies only to the message class it was designed for. Verified missionary mail is the strongest input the service accepts, so it gets the long window.

#### The missionary is contacted only if they wrote to us first

A parent can build an entire letters site without their missionary ever knowing — and the printed book at the homecoming is a genuinely good reason to want that. So the rule is narrow and mechanical: **we never email an address that did not write to us.** A parent forwarding a letter never causes mail to reach `{slug}@missionary.org`; nothing is CC'd or BCC'd to the missionary; and once a site is active, a missionary who keeps BCC'ing `post@` hears nothing at all.

The single exception is the claim invitation in step 3, and it isn't really an exception: a missionary who put `post@` on his own BCC line *did* write to us, deliberately. Replying is the same solicited-reply logic that governs `claim@`, and without it his action has no reachable outcome — nobody else in his family knows the service exists, so no forwarder will ever appear to claim the site. It would be guaranteed to expire, every time. The repeat invitations preserve the property exactly, because each one is a reply to a letter he just sent rather than a scheduled message.

**The invitation schedule lives in the `users` table, not in `claim.json`.** A pending site can purge and be recreated; the record of how many invitations a missionary has already had must outlive it, or the taper resets and the schedule silently becomes a loop.

**The ideal path runs the other direction anyway.** A parent forwards the first letter home, gets the claim link, sets up the site, and then asks the missionary to add `post@` to their BCC going forward. The missionary never touches a setup flow, and their weekly letters land on an already-active site. The `direct`-bootstrap path above is the safety net for when nobody thought to do that first — not the path we advertise.

This is a deliberate trade. The alternative — notifying the missionary on *every* pending-site creation, as a check against someone claiming a site they had no business claiming — would forfeit the surprise-gift scenario entirely. Skipping that notice accepts the loophole instead, and the loopholes are bounded elsewhere: provisioning at all requires possessing a genuine letter from that `@missionary.org` address, unclaimed sites evaporate, and the missionary retains an unconditional right of return (below).

#### When a letter arrives for a site that already exists

Common and innocent — grandma sends one in before anyone has invited her, or the missionary keeps BCC'ing `post@` on a site their parent set up. Two sub-cases:

**A `forward` from someone not on the ACL.** Silent rejection would leave the sender believing it worked. If the message carries a DKIM-valid `message/rfc822` original, they get a short reply: *"A letters site already exists for this missionary. Ask whoever set it up to add you — and if you **are** this missionary, email `claim@pdayletters.com` from your `@missionary.org` address to take ownership."* No owner names, no content, nothing they couldn't already infer from holding the letter. Inline-only forwards from unknown senders still get silence.

**A `direct` message from a missionary who isn't on the ACL.** The letter **publishes normally and the missionary hears nothing at all.** This is the surprise-site case working as intended — a parent runs the site, the missionary just BCCs `post@` every week and is never distracted by it. Ownership is available whenever they want it, but only by asking: see below.

### Ownership and the 60-day window

A missionary can take ownership of their own site at any time by emailing **`claim@pdayletters.com`** from their `@missionary.org` address. Mail to `claim@` from any other domain, or failing DMARC, is **ignored without reply** — there is exactly one rule and no exceptions.

The reply contains a signed, single-use claim link. Following it requires a Google or Microsoft sign-in, and that identity is added to `acl.json` as an **additional** `owner`.

**The sign-in identity is almost always a personal account, and that's the point.** `@missionary.org` is Google Workspace, and the tenant may block third-party OAuth entirely (see [External constraints](#external-constraints)) — so in practice a missionary claiming a site signs in with their personal Gmail or Microsoft account. This is exactly the outcome the 60-day window demands, and it arrives for free rather than by persuasion. It is also why the claim step exists at all: the mailbox proves *who you are*, the OAuth sign-in establishes *what identity holds the role*, and decoupling them means ownership never inherits the mailbox's expiry.

**Claiming never demotes anyone.** In the overwhelmingly common case the missionary simply wants access to their own letters while a parent continues to run the site, and evicting the parent would be hostile. Multiple owners are already supported, so the missionary joins the existing set.

**Verified-missionary owners are protected.** The ACL entry created through a `claim@` link is flagged `verifiedMissionary: true` and **cannot be removed by any other owner** — only by that owner themselves. Without this, a genuine dispute degenerates into an owner-removal war that whoever clicks fastest wins. With it, a missionary can join a site claimed by someone with no business owning it, remove that person, and not be removed back.

#### The 60-day cliff

Per [External constraints](#external-constraints), `@missionary.org` access ends **60 days after a missionary returns home**. `claim@` therefore stops working entirely at that point, and so does `direct` publishing.

This is exactly backwards from when disputes tend to surface — "I found out years later there's a site about me" is the case that matters most and the one the mechanism cannot serve. Four responses, none of which depend on the mailbox still being alive after the fact:

1. **Bind a personal account, not the missionary one.** The claim link should be followed with a personal Google or Microsoft account. Ownership then survives indefinitely, because the ACL entry is keyed on an identity that doesn't expire. The `claim@` reply says this in as many words — and if the Church tenant blocks third-party OAuth, it's the only option that works anyway.
2. **Handle the `@missionary.org` owner case defensively, not as an expected path.** If the tenant *does* permit third-party OAuth, a missionary may reach for their Church Google account and end up with an owner identity that dies with the mailbox. Any owner on that domain triggers a persistent, non-dismissible banner in the admin UI: *"This account stops working 60 days after you return home. Add a personal account as an owner now."* It stays until a non-`missionary.org` owner exists. Cheap to implement, and it costs nothing if the case never occurs.
3. **Nudge the existing owner, continuously.** The owner admin view carries a standing prompt — *"Is [missionary] set up on this site? They can only claim it while their `@missionary.org` address works."* This costs nothing, requires no detection of mission end, and resolves the non-adversarial 99% long before the window closes. If `returnDate` is set in `profile.json` (see below), the prompt escalates in the weeks either side of it; otherwise it escalates after ~4 weeks of no new letters. False positives are cheap — it's a banner, not an email.
4. **A human dispute path is the only real backstop after 60 days.** Nothing automated can verify a returned missionary's identity once the address is gone. The archive itself is the evidence: every `direct` message in `raw/` carries a DMARC-verified `@missionary.org` origin, which proves authorship long after the mailbox is deactivated. Turning that into an actual process belongs with the terms-of-use work — tracked in the follow-up issue, and a prerequisite before the service is offered to anyone outside a known circle.

**Deliverability is manageable, because every reply is solicited.** The `claim@` reply is not cold outbound — it answers a message the missionary just sent us. That matters more than domain reputation does: `missionary.org`'s MX is Google, and Gmail weights prior correspondence with a sender heavily as a positive signal. Missionaries email friends and family constantly and receive replies without incident, and this is the same shape.

**But only if we reply from the address they actually wrote to.** The prior-correspondence signal keys on the sender address, so a reply arriving from `no-reply@mail.pdayletters.com` throws away the very thing that makes it solicited — the recipient has never corresponded with that address or that subdomain. Replies to inbound mail must therefore:

- Set **`From:` to the address the sender wrote to** (`claim@pdayletters.com` or `post@pdayletters.com`), not the generic no-reply sender.
- Set **`In-Reply-To:` and `References:`** to the inbound message's `Message-ID`, so it threads as a genuine reply rather than arriving as an unrelated message that merely quotes one.
- Keep the **envelope sender (`Return-Path`) on `mail.pdayletters.com`** for bounce handling. DMARC still passes via DKIM alignment (`d=pdayletters.com` matching the `From:` domain), so nothing is given up — this is standard ESP practice, not a workaround.

Bounces and stray replies then arrive at `claim@`/`post@` and flow through inbound parse, where the classifier drops them like any other unroutable mail. Purely-generated mail with no inbound message to answer — day-7 reminders, ownership nudges — keeps the `no-reply@mail.pdayletters.com` sender, since there is no correspondence signal to preserve.

This is why **pending-site claim emails count as replies, not as self-originated mail.** Each one answers a specific inbound message, so it gets the `From:` and threading treatment above. That matters most for the invitations sent to a missionary who bootstrapped their own site (see [Re-inviting the missionary](#re-inviting-the-missionary)) — they land in a Gmail inbox at `missionary.org`, carry a claim link, and need every deliverability signal available to them. It is also the reason those invitations are triggered by an arriving letter rather than by a timer: a scheduled version of the same message would be cold outbound with a link in it, which is the hardest thing we could possibly try to deliver.

**The residual risk is the link, not the sender.** A short message containing a "click here to take ownership" URL from a young domain is the exact shape of a phishing email, and Gmail scores links from unestablished domains cautiously. Keep the claim email short, plain, and to a single link. Confirm a real delivery to a live `@missionary.org` inbox once an account is available — see [Building blind](#building-blind) for how this ships before that's possible.

**`returnDate` in `profile.json`.** An optional owner-set date, used for two things at once: scheduling the ownership nudges above, and filling in the mission dates on the printed book cover. Derived from the last post's date when absent.

#### Why it's built this way

- **Nothing renders before a claim.** An unclaimed site has no rendered artifacts, no ACL, and no URL that resolves — so an unauthorized or spam-triggered pending site is inert, cheap, and self-cleaning. It also means expiry deletes one prefix rather than reconciling four.
- **Dedup deferred to claim time.** Dedup's source of truth is `posts.json`, which doesn't exist yet during pending. Rather than inventing a parallel mechanism, pending simply accumulates raw and dedups once at promotion.
- **A signed claim token is genuinely necessary here** — unlike unsubscribe links, where the recipient is already an ACL member. At claim time there is no ACL to check against, so the token *is* the authorization. Single-use, HMAC-signed with a Key Vault secret, stored only as a hash, and expiring with the pending site rather than on a fixed clock of its own (see step 5). The same mechanism, scoped to one slug and one role, backs [invitations](#invitations).
- **The claim email should say so explicitly:** *"If you'd like a parent to manage this site, just forward this email to them."* That turns the missionary's most likely action — forwarding — into the setup step.

### Notification preferences

Per-user (not per-missionary) preferences for outbound emails the service generates. Stored as columns on the user's row in the `users` Azure Table — same row that holds identity metadata (display name, auth provider, first-seen timestamp) so all per-user state lives in one place. Additional preferences are just additional columns.

A `users` row is **created by the ingest path**, not only by sign-in. The missionary at `elder.smith@missionary.org` receives acknowledgments and may never sign in with Google or Microsoft at all, but still needs somewhere to record that they'd rather not be emailed.

Initial preferences:

- **`postAckEmails`** — bool. Sends a short *"Posted — thanks!"* reply on every successfully published letter. **Default `true` for everyone except `@missionary.org` senders, where it defaults to `false`.** The two groups have genuinely different needs: a forwarder is actively managing a site and needs to know their forward landed, whereas a missionary adding `post@` to their weekly email should never hear from us again. A weekly ack is 104 interruptions across a mission, each one consuming scarce P-day computer time, in service of a site somebody else is watching. And that's the real argument — **the missionary isn't monitoring the site; the owner is.** If letters stop arriving, a parent notices first. Missionaries who *want* confirmation can turn it on from the settings page or the `claim@` reply.
- **`dedupeAckEmails`** — bool, default `true`. Sends a *"we already have this one — thanks!"* reply when a forwarded email is de-duplicated against an existing post.

**Neither ack fires for messages promoted out of a pending site.** Both are answering the question *"did my forward work?"*, and at promotion the claim redirect has just put the sender on the finished site with every letter visible on it. See step 6 of the [onboarding flow](#flow). This is a property of the promotion path rather than a per-user preference — there is nothing to opt into, because a batch ack at that moment is never the fastest way to learn the answer.

Every generated email carries a one-click opt-out for its own category ("Don't email me every time a letter posts"). The link is a **signed token** hitting a Function endpoint that flips the flag directly, with no sign-in required. It cannot point at the authenticated settings page instead, because acks go to `@missionary.org` senders who typically have no Google or Microsoft identity and cannot sign in at all. The claim flow already requires an HMAC signing service, so this reuses it rather than adding one.

An authenticated settings page at `/{slug}/settings` still exists for ACL members who'd rather toggle preferences directly.

**Mail-loop protection.** Because the service replies to essentially every inbound message, a misconfigured autoresponder on the other end could ping-pong indefinitely. Three guards: outbound acks carry `Auto-Submitted: auto-replied` (RFC 3834); inbound messages carrying `Auto-Submitted` other than `no`, or `Precedence: bulk`/`list`/`junk`, are never acked; and no ack is ever sent to an address on one of our own ingest domains.

Acks double as an end-to-end smoke test for the send-and-receive email pipeline: they exercise SendGrid send from `no-reply@mail.pdayletters.com` (the single canonical sender — see [Domains](#domains)), the token-signing service, and the `users` table read/write path.

### Moderation / quarantine

**Hands-off by design.** Posts publish immediately on ingest. Owners can edit any post's subject or body, hide, or delete via a lightweight authenticated admin view (see [Access control](#access-control)) — that gives them everything an approval workflow would, without slowing down the common case.

Rationale: missionaries have limited P-day computer time; adding a pending-approval step defeats the "zero effort" goal. Anything an approval queue would catch is equally fixable post-publish through the standard edit/hide/delete tools — usually before family notices, since owners are typically parents already watching for new posts. If real missionaries later ask for a pre-publish gate, we'll add it in response to that request rather than in anticipation of it.

### Post-mission archive

**Nothing about the site changes when a missionary comes home.** No "read-only mode" flip, no state transition, no admin action. The letters simply stop arriving. Owners retain full edit/hide/delete rights on individual posts; anyone on the ACL can still forward historical emails that surface later (an aunt finds an old email in her inbox two years post-mission and forwards it — it lands normally). Nothing on our side needs to happen.

**The one thing that does expire is the missionary's ability to claim the site.** Their `@missionary.org` address stops working 60 days after they return, taking `claim@` with it — see [Ownership and the 60-day window](#ownership-and-the-60-day-window). Late-arriving *forwards* are unaffected, because routing reads the `@missionary.org` address out of the archived historical header rather than contacting a live mailbox; a letter forwarded in 2032 still resolves to the right slug.

**Anyone on the ACL** can, at any time (during or after the mission):

- **Download the offline archive** — one-click "Download my letters" produces a self-contained zip:
  - `index.html` — the same reader UI, but pointed at local files
  - `posts.json`
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
| Static Web Apps | Standard | Web UI + auth + managed Functions. Standard is **required** — Google is a custom identity provider and isn't available on Free. | ~$9 |
| Azure Functions | Consumption (via SWA managed) | Intake, ingest, render, content delivery, admin API, pending purge timer | ~$0 |
| Storage account | Standard **GRS**, Cool tier default | Raw archive + rendered artifacts + `users`/`memberships` tables + `ingest`/`render` queues | <$3 for years of data |
| SendGrid | Free tier | Inbound Parse + outbound ack/claim mail | $0 |
| Key Vault | Standard | SendGrid API key, Lulu OAuth secret, HMAC token-signing key | ~$0.03 |
| Custom domains + certs | Managed by SWA | `pdayletters.com` (canonical) + 3 redirect entry points | $0 (certs are managed) |

**Rough total: ~$12–15/month** at low volume.

**GRS rather than LRS on storage.** LRS keeps three copies in a single datacenter, which does not survive a regional loss — an awkward fit for a service whose central promise is that these letters are preserved permanently and are, for many families, the only surviving copy. The delta is roughly a dollar a month at this scale. If the cost ever matters, the right narrowing is GRS on `raw/` only (the irreplaceable data) with LRS on `rendered/`, which is fully reconstructible from `raw/`.

---

## Build plan (proposed phases)

Reordered to validate the highest-risk piece (email pipeline) first, with intentionally rudimentary UIs at each stage to confirm the plumbing works end-to-end before we invest in polish. See [docs/email-options.md](email-options.md) for the vendor / pricing comparison behind the email decisions in Phase 0.

### Phase 0 — Foundation
- Domains already registered: `pdayletters.com` (canonical), `pdayemail.com`, `pday.email`, `missionaryjournal.org`. Verify each in the SWA custom-domain UI; configure the three non-canonical domains as 301 redirects to the canonical.
- Set the `ACCEPTED_INGEST_DOMAINS` Function app setting to the four accepted domains, and `MISSIONARY_DOMAINS` to `missionary.org` — overridden to a controlled test domain in non-production, per [Building blind](#building-blind).
- Create Azure subscription resource group.
- Storage account (GRS): containers `raw/` (soft-delete + versioning on), `pending/`, `rendered/`, `config/` — **all private, public blob access disabled at the account level**. Azure Tables `users` and `memberships`. Storage Queues `ingest` and `render`. Lifecycle rule deleting `raw/_inbox/` blobs at 30 days.
- Key Vault + managed identity for Functions (SendGrid API key, HMAC token-signing key, Lulu OAuth secret).
- App Insights instance (for rejection logging and general telemetry).
- Provision SendGrid. DNS on all four domains: **MX on the apex** pointing at SendGrid Inbound Parse; DKIM CNAMEs and DMARC policy only on `pdayletters.com` since it's the sole outbound sender, with sending subdomain `mail.pdayletters.com`.
- **Deferred verification — blocked on access to a real `@missionary.org` account.** These are not Phase 0 gates, because we cannot run them yet (see [Building blind](#building-blind)). They are the checklist to run the moment an account is available, and the build proceeds against a stand-in domain until then:
  - Send a real message from a missionary account and inspect `Authentication-Results` for an actual DMARC pass, confirming the `direct` classifier's header parsing.
  - Send a threaded reply per the rules in [Ownership and the 60-day window](#ownership-and-the-60-day-window) and confirm it lands in the inbox rather than spam. Expected to pass — it's a solicited reply into Gmail — and partially testable in the meantime against an ordinary Gmail account.
  - Test whether an `@missionary.org` Google account can sign in to a third-party OAuth app. Determines the wording of the claim email, not the architecture.

### Phase 1 — Inbound email pipeline (receive → classify → save)
- **Build an `.eml` fixture corpus first.** Collect real forwards of the same message from Gmail web, Gmail iOS/Android, Outlook desktop/web, and Apple Mail — both "forward inline" and "forward as attachment" — plus a BCC'd original, a message with `cid:` inline images, and one with HEIC attachments. Check them into the repo as test fixtures. Nearly every hard bug in this system lives in MIME parsing, and this corpus is the only way to find them without waiting on live mail. Since no `@missionary.org` account is available, fixtures use a stand-in domain and hand-written `Authentication-Results` headers covering pass, fail, and absent cases.
- Intake Function: SendGrid Inbound Parse webhook that writes the raw POST body to `raw/_inbox/{ulid}.raw`, enqueues the ULID, returns 200, and does nothing else.
- Queue-triggered ingest Function:
  - Classifier: `direct` / `forward` / `rejected` per the [message classification](#message-classification) table. DKIM re-verification against the sender domain's public key for `forward` messages with an embedded `.eml`.
  - **Diagnostics for the unverifiable paths** per [Building blind](#building-blind): log the full `Authentication-Results` header verbatim for any message whose `From:` domain is in `MISSIONARY_DOMAINS`, and raise a warning — not a silent rejection — when such a message fails to classify.
  - Slug resolution via [sender-based routing](#sender-based-routing); forwarder-vs-ACL check for `forward` messages; inline forwards accepted only from owners.
  - Original-message extractor: `message/rfc822` attachments first, then inline-forward fallback (Gmail / Apple Mail / Outlook separators).
  - Append a bare post record to `rendered/{slug}/posts.json` (subject, body, original headers — `photos: []` for now) and write raw MIME + attachments to `raw/{slug}/{msgId}/` with sanitized path segments. Log rejections to App Insights only (sender, subject, reason, timestamp — no body).
- No dedup yet — every accepted message becomes a post. Any duplicates produced during bulk-forward testing get cleaned up when Phase 2 lands.
- ACL for this phase is a **hand-edited JSON blob** — no auth UI yet. Manually add test accounts.
- **Verification UI:** a page at `/manage/last-received` listing the most recent 50 messages in `raw/` (subject, class, sender, `receivedAt`). Two constraints, both non-negotiable even for a throwaway page: it is **behind SWA authentication and restricted to an operator allowlist** — sender addresses and subject lines of private family mail are exactly what this service is built to protect — and it must **not** live under `/admin/*`, because the Azure Functions host reserves the `admin` route prefix for its own management API. Functions registered there deploy without complaint and then 404 at runtime.

### Phase 2 — De-duplication, onboarding, and outbound send
- Dedup at ingest time, scanning `rendered/{slug}/posts.json`: exact `originalMessageId` match first, then the sender+day hard gate plus exact normalized subject **or** `bodyHead100` match per [de-duplicating forwards](#extracting-and-de-duplicating-forwards). Optimistic-concurrency retry on ETag conflicts; `If-None-Match: *` on first write.
- Ingest becomes conditional: on match-miss, append the post skeleton to `posts.json` with `If-Match` and write raw/; on match-hit, don't touch either and send a courtesy ack instead.
- **Pending sites and the claim flow** per [Onboarding and auto-provisioning](#onboarding-and-auto-provisioning): unresolvable-but-valid slugs create `pending/{slug}/`; a claim email to the forwarder, or the tapering invitation series to a missionary whose own `direct` messages created the site, driven by `claimEmailSentAt` / `claimEmailCount` on their `users` row and always sent as a reply to an arriving letter; **an anonymous-allowed `/claim/{token}` landing page** showing the missionary's name, waiting counts, and sample subjects before any sign-in, threading `post_login_redirect_uri` back to itself, then establishing the first owner, collecting the display name, and promoting accumulated raw; **a failure page** for spent, stale, or already-claimed tokens, including "email me a new link" restricted to previously-emailed addresses; claim tokens sharing the pending site's rolling `expiresAt`; one day-7 reminder per pending site to forwarders only; rolling `expiresAt` reset on every message, at 60 days once `hasDirect` is set and 14 days otherwise; timer-triggered purge when the window lapses.
- **`claim@` handler** per [Ownership and the 60-day window](#ownership-and-the-60-day-window): accept only DMARC-passing senders in `MISSIONARY_DOMAINS`, ignore everything else without reply, mail back a signed claim link that adds a `verifiedMissionary` owner. Reply copy must tell them to sign in with a **personal** Google/Microsoft account and explain the 60-day expiry. **Ships behind a feature flag** and is exercised end-to-end against a stand-in domain — see [Building blind](#building-blind).
- The "a site already exists" reply for DKIM-verified non-ACL senders, including `claim@` instructions.
- HMAC token-signing service (claim links + one-click opt-out links), key from Key Vault.
- Ack emails: post-published ack and dedupe ack, honoring `postAckEmails` / `dedupeAckEmails` on the recipient's `users` row, with `Auto-Submitted: auto-replied` and the loop guards. Both are suppressed on the pending-promotion path. Replies to inbound mail set `From:` to the address written to and carry `In-Reply-To`/`References` threading headers.
- Settings page fragment at `/{slug}/settings` with both toggles (auth via SWA identity). One-click token links flip flags without sign-in.
- **Verification:** hand-craft duplicate forwards from a test mailbox and confirm the raw folder count stays flat while the ack arrives. Bulk-forward five near-simultaneously to exercise the ETag-retry path. Forward from an unknown address, confirm a pending site is created and nothing renders, then claim it end-to-end — confirming the pre-sign-in page shows correct counts, that the token survives the OAuth redirect, and that all accumulated messages appear deduplicated and in date order. Re-click a spent claim link and confirm the "already set up" page rather than an error. Let a second pending site expire and confirm it purges. Send a `direct` message from the stand-in missionary domain to a slug with no site and confirm exactly one invitation goes out, that a second `direct` message resets `expiresAt` without sending another, and that the window is 60 days rather than 14. Back-date `claimEmailSentAt` past each taper threshold and confirm the next arriving letter triggers exactly one re-invitation carrying the correct waiting-letter count. Send a `direct` message from the stand-in missionary domain to a slug with no site and confirm exactly one invitation goes out, that a second `direct` message resets `expiresAt` without sending another, and that the window is 60 days rather than 14. Back-date `claimEmailSentAt` past each taper threshold and confirm the next arriving letter triggers exactly one re-invitation carrying the correct waiting-letter count.

### Phase 3 — Render pipeline
- Queue-triggered render Function: parse raw `.eml` → **sanitize HTML** per [Content sanitization](#content-sanitization) (allowlist, `cid:` rewriting, remote-image stripping) → resize photos to WebP + strip EXIF → write photos to `rendered/{slug}/photos/{p_sha256[:12]}/*` and fill in the target post's `photos` array in `posts.json` (ETag-guarded, same as ingest).
- HEIC decoding from the outset — iPhone missionaries make this the common case, not an edge case.
- Guard against oversized messages: cap decoded attachment bytes per message and stream rather than buffer, so a 25 MB email doesn't exhaust a Consumption instance's memory or its execution timeout.
- Idempotent: rerunning against the same `raw/` yields the same rendered output, guaranteed by content-hash photo IDs. Post text and dedup fields are already in `posts.json` from Phase 1/2; render only fills in photo-related fields and sanitized HTML, so double-runs are safe.
- **Verification:** extend the operator page to list rendered posts alongside a thumbnail strip; confirm posts sort by `originalDate` and that photo arrays fill in shortly after ingest. Run the Phase 1 fixture corpus through and diff the rendered output.

### Phase 4 — Reader UI
- **Public landing page at `/`** — what the service is, the `post@pdayletters.com` address, and the `claim@pdayletters.com` instructions. Unauthenticated, entirely generic, no per-site information.
- Path-routed `/{missionary-slug}` reader: list posts sorted by `originalDate`, post view, photo album, MiniSearch index built client-side from `posts.json`.
- Content is served through `/api/content/…` and `/api/photo/…` per [Private content delivery](#private-content-delivery) from the start.
- **Smoke-tested against a synthetic slug** seeded with fabricated letters and stock photos, with real test accounts on its ACL. Deliberately *not* a `public: true` escape hatch on a real missionary's site — a temporary flag that exposes real family mail is precisely the kind of thing that survives to production, and building the UI against the authenticated path from day one means Phase 5 has nothing to retrofit.

### Phase 5 — Auth & ACL
- SWA Standard with Google + Microsoft providers.
- Load `acl.json` from `config/{slug}/` and enforce via SWA route rules + API-level checks.
- **`memberships` table** maintained alongside `acl.json` on every invite, revoke, and claim, plus a rebuild-from-`config/*` utility for drift recovery.
- **Site switcher** in the header, rendered only for users with more than one membership; **signed-in root redirect** to the most recently updated site, with the no-memberships explanation for an address that isn't on any ACL. See [Switching between sites](#switching-between-sites).
- **Session-expiry handling** per [Sessions expire](#sessions-expire-and-re-authenticating-must-be-invisible): a `/login` chooser page offering both providers, a `401` response override redirecting deep links there with `post_login_redirect_uri=.referrer`, and a **Sign in** button on the public root pointing back at `/`. Verify that `.referrer` substitution survives the hop through `/login`.
- Owner admin view: manage invitees, hide/delete posts, edit any post's subject or body (for copy-editing, retroactive anonymization of names or locations, or fixing typos after publication). Edited bodies pass through the same sanitizer as ingested ones.
- **Invitations** per [Invitations](#invitations): bulk paste-and-parse of addresses, one signed single-use invitation email per invitee naming the inviting owner, identity binding on acceptance rather than address matching, `invited` / `active` state in the admin list, and manual owner-initiated resend that invalidates the prior token. No automated reminders to invitees, ever.
- **`403` handling** per [Signed in, but not on the list](#signed-in-but-not-on-the-list): a page naming the rejected identity with a sign-out-and-switch-account action, distinct from the `401` re-authentication path.
- **Ownership-window UI** per [Ownership and the 60-day window](#ownership-and-the-60-day-window): enforce `verifiedMissionary` removal protection; persistent banner while any owner is on `missionary.org`; standing prompt to the existing owner to get the missionary claimed while their address still works.

### Phase 6 — Polish
- Photo album view (aggregated across all posts for a missionary).
- Search UI refinement (highlights, snippets, filters).
- Owner-managed profile (display name, optional `returnDate` — drives the ownership-window nudges and the book cover's mission dates).
- `alternateSenders` in `profile.json` — owner-managed additional addresses that map to this slug, for missionaries permitted to write from a personal account.
- Per-slug daily ingest cap with alerting, so a mail loop or a forwarding rule gone wrong can't quietly generate thousands of posts and a matching storage bill.

### Phase 7 — Offline archive export
- "Download my letters" Function bundles `index.html` + `posts.json` + `photos/` + (optionally) `raw/` into a self-contained zip. Attachment path segments are re-sanitized on the way in to avoid zip-slip on the user's machine.
- Packaged reader HTML reads local JSON and builds the search index in-browser — identical code path to the hosted reader, so search works with zero backend.

### Phase 8 — Journal Publish
- Assemble a hardcover photo book from a missionary's posts + photos and place the print order via the Lulu Print API.
- Full design in [Journal Publish](#journal-publish), including why Shutterfly + Rakuten was ruled out.

---

## Open questions to confirm

1. **Permanent deletion vs. soft delete.** The owner-facing promise is that "delete everything" is permanent, but `raw/` has soft-delete and versioning enabled precisely so nothing is ever lost. These are in direct conflict. Options: honor deletion by also purging soft-deleted versions and blob snapshots (simple, matches the promise, forfeits the safety net); or restate the promise as "removed from the service, retained for N days, then permanently erased" (safer against misclicks, requires saying so in the UI). Leaning toward the latter with N = 30 and explicit wording at the confirmation prompt.
2. **Journal Publish pricing:** pass through Lulu's wholesale cost, or add a small service fee?
3. **Journal Publish trim size:** fixed template initially, or configurable?
