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

  This largely **de-risks the `direct` path**: an enforcing `p=quarantine` policy can only be maintained if the domain's own outbound mail aligns, so `Authentication-Results` on a genuine missionary email should show a DMARC pass. It is still confirmed against a real message before `direct` goes live — relaxed alignment and a Proofpoint relay leave enough room that it's worth seeing an actual header rather than inferring one.

  It also clarifies **where filtering happens**. Proofpoint appears only in SPF, so it is the **outbound relay** — inbound mail to a missionary lands at **Gmail**, and Gmail's filtering is what our replies must satisfy. Two consequences: Gmail weights prior correspondence with a sender heavily, and Gmail's behavior can be tested against any ordinary Gmail account. (A tenant can route inbound through a third-party scanner via Google-side rules that DNS won't reveal, so this is the likely picture rather than a certain one.)

  **Confirmed against a real message, August 2026.** A genuine `@missionary.org` send to `post@` produced, at the Cloudflare hop:

  ```
  Authentication-Results: mx.cloudflare.net;
    dkim=pass header.d=missionary.org header.s=google header.b=…;
    dmarc=pass header.from=missionary.org policy.dmarc=quarantine;
    spf=none (… no SPF records found for postmaster@mail-ed1-x532.google.com) smtp.helo=…;
    spf=pass (… domain of …@missionary.org designates 2a00:1450:4864:20::532 as permitted sender) smtp.mailfrom=…@missionary.org;
    arc=pass smtp.remote-ip="2a00:1450:4864:20::532"
  ```

  The `direct` path authenticates cleanly, and `policy.dmarc=quarantine` matches the published record. Two details differ from what the DNS inspection predicted. **Outbound does not traverse Proofpoint**: the signature is `d=missionary.org; s=google`, the sending host is `mail-ed1-x532.google.com`, and the `Message-ID` ends `@mail.gmail.com` — mail leaves Google directly, so the relay adds no complication to alignment. And **the header carries two `spf=` results**, which drives the parsing rules below.
- **⚠️ We have no access to an `@missionary.org` account yet.** Every path that depends on one — `direct` classification, `claim@`, and the OAuth question below — must be **implemented blind and verified later**. This does not block the build, but it changes how the build has to be done: see [Building blind](#building-blind). Access is expected rather than hypothetical — a missionary in the author's own family enters the field partway through the build — so this is a scheduling constraint on one phase, not a permanent condition. The design still must not *depend* on the answer, because the next person to run this service will not have that account either.
- **⚠️ It is unknown whether an `@missionary.org` Google account can sign in to third-party apps at all.** Google Workspace admins can block or allowlist third-party OAuth access tenant-wide. The design must not depend on the answer — and doesn't: the claim flow separates *proving control of the mailbox* (email) from *which identity owns the site* (OAuth), so a missionary who cannot use their Church account binds a personal one. Worth testing eventually, because it determines how the claim email should be worded.

### Building blind

Three of the constraints above cannot be verified until someone with a real `@missionary.org` account is available to test with. That access is expected partway through the build rather than never, so this is about **sequencing the unverifiable work behind everything else** — and building so that being wrong is cheap and immediately visible when the answers finally arrive.

**The build is ordered so the blind parts come last.** [Stage 1](#stage-1--vertical-slice) is forward-only: it needs a genuine missionary letter, but only as an *attachment* someone forwards, which any family member on a mission already has. Everything that requires *sending* from `@missionary.org` — `direct` classification, `claim@`, the ownership flow — is deferred to [Phase 6](#phase-6--direct-ingest) and later, by which point the account exists. Nothing waits on it that didn't have to.

**Make the missionary domain configuration, not a constant.** A `MISSIONARY_DOMAINS` Function app setting (default `missionary.org`) is what the classifier, slug derivation, and the `claim@` handler all check against. This single change converts "untestable" into "testable against a stand-in": point it at a domain we control — a test Google Workspace domain, or even a personal Gmail address during development — and the entire `direct` and `claim@` flow can be exercised end to end, including DMARC evaluation, slug derivation, claim-token issuance, sign-in binding, and the `verifiedMissionary` ACL write. It stays worth keeping after real access arrives, because it is also how the service absorbs a second Church domain.

**Most of the risk isn't logic — it's header format.** Our code never performs DMARC itself; the inbound provider does, and the classifier reads the resulting `Authentication-Results` header. So the classification *logic* is fully testable offline against hand-crafted `.eml` fixtures. What we genuinely cannot know is the exact shape of that header for real `missionary.org` mail routed through Proofpoint. That is a parsing question with a narrow failure surface, not an architectural unknown.

**Instrument for the first real message.** Because that first genuine missionary email is the actual test, it must produce a complete diagnostic rather than a silent drop:

- Log the **full `Authentication-Results` header verbatim** to App Insights for every message whose `From:` domain is in `MISSIONARY_DOMAINS`, whether it classifies or not.
- A message from a configured missionary domain that **fails** classification is logged at warning level with the parse failure and the raw header — never folded into the ordinary silent-rejection path, where it would be indistinguishable from spam.
- `inbox/` already retains the verbatim payload for 30 days, so a message misclassified by a header-parsing bug can be reprocessed after a fix rather than lost.

**Feature-flag `claim@`.** Keep the handler behind a setting so it can ship dark and be enabled once a real round-trip has been observed. Until then `claim@` accepts mail and does nothing, which is indistinguishable from the documented "ignored without reply" behavior and therefore leaks nothing.

**Accept that the first real missionary is the pilot.** The first onboarding should be someone we can talk to directly, so a failure is a conversation rather than a support ticket from a stranger.

---

## High-level architecture

```
     Missionary ──BCC──┐         ┌── forwards ── Family/Friends
    writes email       │         │                    reads
                       ▼         ▼                      │
            ┌──────────────────────────┐                ▼
            │  Cloudflare Email Routing│      ┌──────────────────┐
            │  MX on pdayletters.com   │      │  Static Web App  │◄─ Google / MS
            │  post@ · claim@ only     │      │  (Standard tier) │      auth
            └───────────┬──────────────┘      │  /{missionary}   │
                        │ in-SMTP             └────────┬─────────┘
                        ▼                              │ x-ms-client-
            ┌──────────────────────────┐               │  principal
            │  Email Worker            │               ▼
            │  dump raw + enqueue.     │   ┌──────────────────────────┐
            │  No parsing. No logic.   │   │  Functions API           │
            └───────────┬──────────────┘   │  /api/content/{slug}/…   │
                        ▼                  │  /api/photo/{slug}/…     │
            ┌──────────────────────────┐   │  manage · ACL · claim    │
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

### The service is in beta until the privacy policy ships

Every surface carrying the product name — the public landing page, the site header, the footer of outbound email — carries a small **beta** mark beside it. Deliberately subtle: one word next to the name, not a banner, not an interstitial, nothing to dismiss.

**It is a factual claim, not a disclaimer.** There is no terms of use, no privacy policy, no written takedown process, and — per [Building blind](#building-blind) — several paths that have never run against a real `@missionary.org` account. Someone about to hand over two years of their family's letters is entitled to know that going in.

**Publishing the privacy policy is what removes it.** A single checkable event rather than a judgment call about readiness. See [Phase 12](#phase-12--leaving-beta).

### Domains

**One domain: `pdayletters.com`.** All web UI, auth, mail, and outbound links point here.

Three other names were registered speculatively — `pdayemail.com`, `pday.email`, and `missionaryjournal.org` — and are **deliberately not used**. Serving them would mean a second MX path, a second entry in `ACCEPTED_INGEST_DOMAINS`, redirect rules to maintain, and a fourth spelling of the address for people to get wrong. None of that buys a user anything: everyone is told one address, and that address is the only one that has ever been advertised. They can be redirected later if a real need appears, or allowed to lapse.

**Why one canonical web domain rather than several?** Azure Static Web Apps scopes auth session cookies (and the OAuth relying-party redirect) to a single hostname. Sharing a signed-in session across sibling domains would require hand-rolling cross-domain token passing — fragile, extra security surface, no user benefit.

**Two shared addresses.** There is no per-missionary ingest address — everyone everywhere is told to use the same two:

| Address | Verb | Who may use it |
|---|---|---|
| **`post@pdayletters.com`** | "Publish this letter." | Anyone. The classifier decides what's accepted. |
| **`claim@pdayletters.com`** | "I am this missionary; give me control of my site." | `@missionary.org` senders only, DMARC-verified. Everything else is ignored without reply. |

Cloudflare Email Routing accepts a catch-all, so *every* address at the domain arrives at the Worker. The classifier honours exactly these two local-parts and silently drops the rest; there is no per-address route configuration to keep in sync.

The target letters site is determined from **who wrote the letter**, not from which address received it — see [Sender-based routing](#sender-based-routing). The accepted-domain list is a Function app setting (`ACCEPTED_INGEST_DOMAINS`), not a config blob; it holds one value today and changes roughly never.

**Why two addresses rather than one?** `post@` and `claim@` express different *intents*, and separating them is what lets the `post@` path stay completely silent for missionaries. If a single address had to serve both, the system would have to infer intent — typically "reply if this sender isn't on the ACL yet" — which would send an unsolicited email to exactly the missionary whose parent is building a surprise site. An explicit address makes the request unambiguous and makes replying safe, because sending to `claim@` *is* the consent to be replied to.

This does not weaken sender-based routing. The recipient address selects a **verb**, never a **target**; the slug still comes entirely from the authenticated author, so there remains no attacker-supplied "which site" value.

**Why one address per verb instead of `{slug}@…`?** Three wins. (1) **Instructions get trivial** — "forward your missionary's email to `post@pdayletters.com`" works for every user of the service, with nothing to look up or personalize. (2) **It removes a whole class of security bug**, because there is no attacker-supplied "which site" value left to validate — see [Sender-based routing](#sender-based-routing). (3) **No address provisioning at onboarding** — nothing to allocate, alias, or communicate when a new site is created.

A variant with an unguessable suffix (`{slug}-{4-char-token}@…`) is rejected for a separate reason: the classifier already drops anything that isn't a verified `direct` or an ACL-member `forward`, so obscurity buys no defense while costing an ugly address, a `profile.json` field, extra parser logic, and a rotation UI.

**MX lives on the apex** of each domain, pointing at the inbound provider. This does not collide with outbound: sending happens from `no-reply@mail.pdayletters.com`, so bounce and delivery-event handling stay on the `mail.` subdomain and never touch the inbound parse path.

**Trade-off accepted:** a single well-known address attracts more spam than four semi-obscure per-missionary addresses did. Mitigated by the classifier (silent drop for any sender we can't tie to a site or to a valid claim), by the inbound provider's spam scoring, and by the fact that rejected mail never reaches `rendered/` and ages out of the intake quarantine in 30 days.

**Outbound mail is DKIM-signed as `pdayletters.com`, with the envelope sender on `mail.pdayletters.com`.** SPF/DKIM/DMARC are configured on `pdayletters.com` only, which keeps sender-authentication configuration simple. The visible `From:` differs by message type: **replies to inbound mail are sent from the address the sender wrote to** (`post@` or `claim@`) to preserve the recipient's prior-correspondence signal, while self-originated mail — day-7 reminders, ownership nudges, and [invitations](#invitations) — comes from `no-reply@mail.pdayletters.com`. DMARC passes either way through DKIM alignment. See [Ownership and the 60-day window](#ownership-and-the-60-day-window) for why this matters.

### Email ingestion

#### Message classification

Inbound messages fall into one of these classes based on what the intake code can verify. Only classified-as-accepted messages are written to `raw/`; everything else is dropped silently.

| Class | Detection | Publish? |
|---|---|---|
| `direct` | `From:` is `@missionary.org` and DMARC passes with `header.from` aligned to that domain, per `Authentication-Results`. The `From:` local-part **is** the target slug. | Yes |
| `forward` | The original message is recoverable (a `message/rfc822` attachment, or inline forwarded text), its `From:` resolves to a known slug, and the forwarder is on that slug's ACL with a passing DMARC result of their own | Yes |
| `rejected` | None of the above — no recoverable `@missionary.org` author, or the forwarder isn't on the resolved slug's ACL, or authentication of the forwarder itself failed | No — drop silently, log to App Insights |

Provenance for `forward` messages is captured in an `extractionSource` metadata field for audit/debug: `rfc822` (embedded `.eml` was present) or `inline` (parsed from forwarded-text separators). The originating client (Gmail / Outlook / Apple Mail) and DKIM re-verify pass/fail are logged to App Insights at ingest time but not stored on the post — both can be re-derived from the preserved raw MIME if a specific extractor ever turns out to be buggy and we need to requery history.

**A forwarder on a domain that publishes no DMARC record cannot forward.** DMARC only reports `pass` when a policy is actually published; with no `_dmarc` TXT record the result is `none`, which is not a pass, and the message classifies as `rejected` and is dropped silently. This is invisible to the sender — they get no bounce, because the message was accepted at SMTP and discarded afterwards. The big consumer providers (Gmail, Outlook.com, Yahoo) all publish DMARC, so the common case is fine; the gap is a family member on a **custom domain** who set up SPF years ago and never added DMARC. The first real account hit this — `kurtzeborn.org` had correct SPF and no DMARC at all.

This is a rough edge with no good automated fix: we cannot publish DNS on someone else's domain, and relaxing the check to accept bare SPF would weaken the one authentication signal the forward path has. What the service *can* do is not fail silently at the point it matters — when an invited ACL member's domain lacks DMARC, say so in the admin UI at invite time rather than letting them discover it by forwarding twenty letters into a void. Deferred until the invitation flow exists (Phase 7); noted here because the diagnosis is otherwise extremely unpleasant.

Design principles:

- **Never trust the `From:` header alone.** Always require a DMARC pass aligned to that `From:` domain — on the outer envelope for `direct`, on the forwarder for a `forward`.
- **Select the `Authentication-Results` header by `authserv-id`, never by position.** A forwarded message carries one such header per hop, and the sender can put arbitrary `Authentication-Results` lines into the message they compose. Only the one stamped by our own inbound provider — `mx.cloudflare.net` — is evidence; the rest are sender-supplied text that happens to look official. RFC 8601 makes this the required behaviour, and the failure mode is not merely a wrong verdict: reading the first header found is a trivially forgeable authentication bypass. If no header bearing the expected `authserv-id` is present, the result is `none`, not "try the next one." The fixture corpus exercises this directly — the captures carry a Gmail `dmarc=fail` positioned *above* Cloudflare's `dmarc=pass`, so a position-based reader fails them and a correct reader accepts them.
- **Match the header name exactly; `ARC-Authentication-Results` is not it.** That header contains `Authentication-Results` as a substring and carries the *same* `authserv-id`, so an unanchored match finds it first. Real captures contain both, adjacent, with the ARC copy appearing earlier.
- **A header with no `authserv-id` at all matches nothing.** Exchange Online omits the identifier entirely, opening straight into `spf=pass (sender IP is …) smtp.mailfrom=…` — valid-looking, genuinely stamped by Microsoft, and not evidence about our ingest path. RFC 8601 requires the field; real senders violate it. Treat a missing identifier as a non-match rather than reaching for a default, or a message that reached a mailbox by some other route carries a verdict we then trust. The corpus pairs one message delivered both ways for exactly this reason: the same send, one copy through Cloudflare and one through Exchange, differing only in the headers each path stamped.
- **A single `Authentication-Results` header can repeat a method.** Real `missionary.org` mail arrives with `spf=none` for `smtp.helo` immediately followed by `spf=pass` for `smtp.mailfrom`. Taking the first `spf=` match rejects a fully authenticated letter. Each result must be selected by its `ptype.property` — `smtp.mailfrom` for SPF — and a method with no matching property is absent rather than failed.
- **Key acceptance on `dmarc=pass` plus `header.from` alignment, not on all three methods passing.** DMARC is already the composite: it passes when SPF *or* DKIM aligns with the `From:` domain. Requiring SPF, DKIM, and DMARC to pass independently adds no security over DMARC alone while rejecting legitimate mail whenever one leg breaks — which is routine, since forwarding rewrites the envelope sender and breaks SPF by design. SPF and DKIM results are recorded for diagnostics; DMARC decides.
- **The target site is derived from the letter's author, never from the recipient address** — see [Sender-based routing](#sender-based-routing). Every message goes to the same `post@` address, so there is no attacker-supplied "which site" input to validate.
- **The forwarder must be on the same ACL that grants them read access to the destination missionary's letters site.** There is no separate "allowed forwarders" list — access implies forwarding rights.
- **Membership is the control for an archive that already exists; cryptography is the control for creating one.** Inline forwarded text was originally restricted to owners, and an embedded original whose signature did not re-verify was held for owner approval. Both rules were defensible in the abstract and unworkable in practice — see [What DKIM re-verification proves](#what-dkim-re-verification-proves). The desktop Outlook client rebuilds every message it forwards, so "hold anything unverified" did not admit only trustworthy letters: it held almost everything from almost everybody, permanently, with no way out. The trust boundary that remains is the invitation. Someone on an ACL was put there deliberately by an owner who can edit or delete anything they post and remove them from the list; that is a smaller risk than an archive nobody can contribute to. **Bootstrap is unchanged and is where the signature still decides**, because it settles whether an archive exists at all and there is no owner there to appeal to.
- **Reject silently — unless the sender has proven they hold real missionary mail.** No bounce or error by default, because bouncing leaks which addresses exist and invites probing. The exception is a message carrying a genuine `@missionary.org` original: that sender demonstrably possesses a real letter, so they're a real person in the circle rather than a prober, and silence would leave them believing their forward worked. They get a short reply explaining what to do — see [Onboarding and auto-provisioning](#onboarding-and-auto-provisioning). Everything else is dropped without a word.
- **Log every rejection** to App Insights (sender, subject, reason, timestamp — no message body). Rejected messages are not archived to blob storage.

#### What DKIM re-verification proves

Re-verification works, and it fails far more often than the design first assumed. The first pass at this measured only whether `mailauth` returned a pass, concluded that every Outlook client was hopeless, and built the owner-hold rule on top of that conclusion. Both halves turned out to be wrong. Measured properly — against the pristine captures in the private repo, splitting the body hash from the header signature, and reading the ARC chain:

| Specimen | `bh=` (body) | `b=` (headers) | ARC seal | Usable? |
| --- | --- | --- | --- | --- |
| Missionary's BCC, through Cloudflare | **pass** | **pass** | — | yes, in full |
| The same message, through Exchange Online | fail | **pass** | `microsoft.com` | yes, headers |
| Forward-as-attachment, Gmail web | **pass** | **pass** | `google.com`, `cv=pass` | yes, in full |
| Forward-as-attachment, Outlook web | fail | **pass** | `microsoft.com`, valid | yes, headers |
| Forward-as-attachment, Outlook desktop | fail | **fail** | chain truncated to `i=1` | **no** |
| Forward-as-attachment, Outlook Android | *no `DKIM-Signature` at all* | — | — | **no** |

RFC 6376 makes `bh=` and `b=` independent: one hashes the body, the other signs the header set. `mailauth` short-circuits on a body-hash mismatch and reports `neutral` without ever checking the signature, which is correct for a delivery decision and useless for this one. Checking the second half separately is what recovered the Outlook web path.

**Signatures expire, and an archive has to ignore that.** A DKIM signature may carry an expiry in `x=`, and Google sets one about a week after `t=`. Checked against the wall clock — which is what every verifier does by default, because every verifier is deciding whether to accept a *delivery* — a letter stops verifying a few days after it was written. That is the exact opposite of what this service needs: it exists to re-verify letters forwarded months or years later, so by the time anyone asks, the answer is always "expired". Nothing about the letter has changed; the question was simply the wrong one.

The right question is not *"is this signature still valid today"* but *"was it valid when it was made"*, so the clock is set to the earliest `t=` the message itself carries. Earliest, not latest: a forward is signed again by the forwarder's provider at the moment of forwarding, and dating the check from that would put the clock years past the missionary's own expiry and lose the letter to the very rule being worked around. `t=` sits inside the signed header block, so moving it means forging the signature, which is what the key prevents. What this gives up is replay protection — an expired signature now verifies forever — and that is deliberate: a replay here is a letter the missionary genuinely did sign, which is precisely what the archive wants to accept.

This one is worth dwelling on because of *how* it was found. It did not fail in review or in testing; it passed both. The captures were taken and the tests written in the same week, when every signature was still inside its expiry window, so the suite went green and stayed green — and then broke a week later, on code nobody had touched, with `mailauth` reporting a body-hash complaint that pointed nowhere near the cause. A test that depends on a message being old cannot be written against a fixture that is new, so the regression test now signs its own letter with a chosen `t=` and `x=` and can be as stale as the question requires, permanently.

**What Exchange changes, exactly.** Three artifacts, all in the body, totalling 79 bytes on a 190 KB message: a `<meta http-equiv="Content-Type">` prepended to the HTML part, a blank line after a nested multipart's closing delimiter, and a blank line after a base64 payload. `text/plain` parts are never touched. Reversing them reproduced Gmail's bytes exactly on one fixture and failed on a live message at every quoted-printable wrap width from 69 to 77 — an overfit, abandoned. The damage is also done *before* any forwarder acts: it happens in the Exchange store, on delivery, so no client-side fix exists.

**Why Outlook desktop is unrecoverable and Outlook web is not.** Same letter, same `Message-ID`, captured through both. Outlook web altered **zero** signed headers. Outlook desktop altered four: the MIME `boundary` was regenerated, `To:` regained a display name, `Subject:` was re-encoded from Q to B, and `Date:` was converted to UTC. All four are inside `b=`. Desktop Outlook reconstructs the message from MAPI properties rather than sending on the bytes it received, so the original never leaves the machine and no parser can recover it. It also drops Microsoft's own ARC set, leaving a one-entry chain.

**Why the seal alone is not enough, and why the header signature alone is not either.** `ARC-Seal` does not cover `From:`, and Microsoft's sealed record names only the domain — checked directly, there is no local part in it:

```
i=2; mx.microsoft.com 1; spf=pass ... dmarc=pass ... header.from=missionary.org;
 dkim=pass (signature was verified) header.d=missionary.org; arc=pass
```

So a seal on its own would let a genuine sealed letter from one missionary be re-attributed to another by rewriting `From:`. Conversely `b=` says nothing whatever about the body. The two cover each other's gap and neither is accepted alone. Both were tested adversarially rather than reasoned about, against a live capture:

| Edit | Outcome |
| --- | --- |
| none | accepted, coverage `headers` |
| sealed `header.d` rewritten | rejected — seal signature invalid |
| sealed `header.from` rewritten | rejected — seal signature invalid |
| sealed `dkim=` verdict rewritten | rejected — seal signature invalid |
| `From:` rewritten, ARC left intact | rejected — header signature fails |
| whitespace added inside the sealed record | accepted — relaxed canonicalization normalises it, correctly |

The trusted-sealer list is deliberately **not** `mailauth`'s. That ships fifteen domains on a "these forwarders are usually honest" basis; the only provider whose seal is load-bearing here is the one that breaks the body hash. `TRUSTED_ARC_SEALERS` defaults to `microsoft.com` alone. The sealer is checked *before* the seal is verified, so an inbound message cannot drive a DNS lookup for a domain of its choosing.

**Coverage, not just a verdict.** `verifyEmbeddedDkim` returns `coverage: 'body' | 'headers' | null` alongside `verified`. `body` means the published words are the signed words. `headers` means only that the letter is from the address and date it claims — the text may since have been rewritten, and on the Outlook path it demonstrably has been. Both are logged. A run of `headers` where there used to be `body` is a provider having changed something.

**Prior art, because this looked too much like our own bug to accept.** It is not. The Thunderbird DKIM Verifier add-on (`lieser/dkim_verifier`) hits exactly this, and its maintainer's only workaround after years is an option to trust the plaintext `Authentication-Results` header — strictly weaker than checking a seal. The same project independently proposed splitting `bh=` from `b=`. The Exchange body rewrite has been reported to Microsoft at least three times since 2017 — a Q&A post with a `dkimpy` before/after proof, a 2023 support case that went quiet, and a 2024 TechCommunity post with one Like and no replies. A third-party Outlook library ships code to undo the injected `<meta>` tag, which only works because it runs inside Outlook on the sender's machine. Nine years, no acknowledgement.

**Would Microsoft 365 as our MX have avoided this?** No, and it would probably have hurt. The Gmail capture's own ARC chain settles it: `google.com` (origin) → `cloudflare-email.net` (our MX) → `google.com`, with the final hop re-verifying `missionary.org`'s signature *after* Cloudflare's and still passing. Cloudflare is byte-transparent. Microsoft's sealed record on the same letter also said `dkim=pass`, so the letter was intact on arrival and broke in their store. Exchange is the mangler, not the transport; Defender's Safe Links and Safe Attachments would operate on the `message/rfc822` part we need untouched, putting the Gmail path that works today at risk; and mechanically it is worse — Cloudflare Email Workers hand us raw MIME synchronously, where Graph would mean polling for `$value`.

The tables above are asserted by `functions/tests/dkim.test.js` and `functions/tests/arc.test.js` rather than left as research notes, so a change in any of these clients' behaviour surfaces as a test failure. The assertions that need the pristine captures and a DNS lookup skip when the private repo is absent — which is every CI run.

#### When the first letter cannot be verified

Bootstrap still requires a signature, so the families whose only mail client is desktop or Android Outlook would otherwise be unable to start an archive at all. They get a reply rather than silence, and it offers two routes in a deliberate order.

There are two such replies — one for a letter quoted inline, one for a letter attached that did not verify — and **both carry the relay link as their second route**. It looks as though the inline reply is the safer one to withhold it from, and it is not. The author address on an inline forward is text the sender typed; the author address on an unverified attachment is a header in a file the sender wrote. Neither is evidence, both take seconds to forge, and the fences behind the link are identical for the two. What withholding it would actually have done is deny the route to whoever has the worst mail client — the Outlook and Gmail phone apps have no *forward as attachment* item at all, so an inline forwarder holding only a phone was being handed advice they could not follow and nothing else.

**Route one: Outlook on the web.** Same mailbox, no new account, and it forwards the message unaltered. This costs nobody anything and it is offered first.

**Route two: ask the missionary to vouch.** The reply carries a signed link. Opening it shows who will be written to and on whose behalf; a button — never a `GET`, because link scanners fetch mailed URLs before people read them — sends the missionary one short note. That note contains **a link, and asks them to forward it to the person who asked**. Whoever opens the forwarded link signs in with a personal account and becomes the owner of the archive; from then on their letters go through, because membership rather than cryptography is what the forward path checks. The letter that failed is simply sent again.

**The missionary forwards a link, not a letter.** This is the whole reason the route works. Asking them to forward a *letter* would either land it on the family member — who is holding the same Outlook client and still cannot forward it on — or require the missionary to send it to us, which drags them into a transaction they have no stake in. A link is text. Every mail client on earth forwards text correctly, including the two that mangle a message.

**It also puts the decision where it always belonged.** Cryptography was never really the question being asked at bootstrap. The question was *should this person be allowed to start an archive of your letters*, and a signature only ever answered it by proxy, on the assumption that anybody holding a genuine letter was already trusted with it. Here the person whose letters they are answers it directly, which is a better answer than the proxy was — and the honest reading of the whole ARC exercise above is that it bought a client that would otherwise have needed this route, not that it settled the question.

**What the grant confers, and what it does not.** Ownership, and not the verified-missionary flag. That flag carries protection from removal and belongs only to somebody who proved control of the mailbox, which is what emailing `claim@` does and what following a forwarded link does not. The missionary can still claim their own archive afterwards by the ordinary route, at which point they can remove whoever set it up.

The grant is recorded in `config/{slug}/relay-claim.json`, alongside `missionary-claim.json` and resolved the same way — by stored hash, never by anything in the token — so which privilege a link carries is never an assertion travelling through a stranger's mailbox. It is fenced four ways: one outstanding grant per missionary, written before the send, so a second requester cannot rewrite the name the missionary was told; spent by the first person to open it, with the redeemer's own retry allowed and anyone else's refused; refused entirely against a slug that already has an ACL, so it is never a way *into* an archive rather than a way to start one; and expiring in fourteen days, which is two P-days and long enough to survive a missionary who reads mail once a week.

**The oracle this opens, stated plainly.** Triggering the note requires a signed link, and that link is minted for the sender of anything that *looked* like a missionary's letter and could not be authenticated — an attached original that failed to verify, or quoted text naming an author. Both are the cases that by definition cannot be authenticated, so a fabricated message reaches either. The consequence is that somebody can cause one message to be sent to a plausible `@missionary.org` address, naming themselves. It is rate-limited to one outstanding grant per missionary and it is not silent — the note names the requester twice, once to act on and once to refuse on, and says outright what forwarding the link hands over. The missionary is the control. That is a weaker gate than a signature and a stronger one than a signature ever actually was for this population, and it is the trade the route exists to make.

#### Sender-based routing

Messages to `post@` carry no routing information in the recipient — the address names a verb, not a destination. The target slug is resolved from **the author of the letter**:

| Case | Slug source |
|---|---|
| `direct` — missionary sent or BCC'd it themselves | Local-part of the outer `From:`, which DMARC has already authenticated |
| `forward` — someone forwarded a missionary's letter | Local-part of the **extracted original's** `From:` |

In both cases the author's address must be in `MISSIONARY_DOMAINS` — a Function app setting defaulting to `missionary.org` (see [Building blind](#building-blind)) — or an owner-registered alternate, and the local-part is used verbatim as the slug per [Missionary routing](#missionary-routing).

**Why this is safer than routing on the recipient.** When the recipient address names the target site, the intake code has to separately prove the sender may publish there — and if that check is missing or wrong, any authenticated missionary can publish to any other missionary's site. Deriving the target from the authenticated author collapses those two steps into one: there is no independent "target" value for an attacker to supply, so there is no mismatch to exploit.

**Forwards resolve to the author, not the forwarder.** A parent with two children serving, or an aunt on several families' ACLs, submits through the same address for all of them and the letters sort themselves out. It also fails safe in the interesting direction: if someone on Elder Smith's ACL forwards a letter written by Elder Jones, it routes to `elder.jones` and is rejected there for lack of ACL membership — rather than being mis-filed into Smith's site.

**BCC works unchanged.** Because routing never reads `To:` or `Cc:`, it makes no difference whether the address was on the `To:`, `Cc:`, or `Bcc:` line. This matters because BCC is the dominant pattern — missionaries put family in `To:` and the ingest address in `Bcc:` so relatives never see it, reply to it, or pass it around. Note that `Bcc:` is not reliably absent either: Gmail leaves a `Bcc:` header naming the recipient in that recipient's own copy, while other providers strip it. A parser reading recipient headers would therefore work by accident on some paths and fail on others; the envelope is the only stable source.

**Unresolvable messages.** If no `@missionary.org` author can be recovered — spam, a `reader` sending an inline forward, a mangled forward, a letter written from an unregistered personal address — the message is rejected silently and logged. Nothing is archived.

**Alternate sender addresses (deferred to Phase 9).** Some missionaries write from a personal account rather than `@missionary.org`, leaving routing nothing to key on. An owner-managed `alternateSenders` array in `profile.json` maps additional addresses onto the slug. Deferred because it requires the owner admin UI to exist first, and because `@missionary.org` covers the overwhelming majority.

#### Extracting and de-duplicating forwards

Because anyone on a missionary's ACL can forward historical email, the intake code has to extract the "true" original message and check whether we already have it — while being tolerant of the small variations email trips through (quoted-reply prefixes, stripped signatures, MIME re-encoding, missing attachments, minor date/time-zone drift).

**MIME parsing is a dependency, not code to write.** `postal-mime` handles the RFC 5322/2045 layer — headers, nested multiparts, transfer encodings, charsets, and `message/rfc822` parts — and is built for serverless runtimes without Node stream or `iconv-lite` baggage. `mailparser` is the mature fallback if a gap turns up. What no library solves is the step after: extracting an original `From` / `Date` / `Subject` out of an *inline* forward is heuristic, client-specific, and locale-specific (a German Outlook writes `-----Ursprüngliche Nachricht-----`). The available reply-splitters aim at trimming quoted replies, not at recovering a forwarded original. That remainder is the only extraction code worth writing by hand, and step 1 below avoids it entirely.

**Cap the message size before the parse call, not after.** A MIME parser fed untrusted mail is an attack surface — deeply nested multiparts, decompression bombs, and absurd part counts all burn CPU before any rule in this design gets a chance to apply. The cap is 26 MiB: Cloudflare refuses anything over 25 MiB at SMTP time, so a larger blob in `inbox/` did not arrive by the mail path at all.

**`{msgId}` is a hash of the `Message-ID`, not a sanitized copy of it.** A `Message-ID` is sender-controlled and can contain path separators, so it cannot be used as a path segment as-is — but sanitizing it risks mapping two distinct IDs onto one directory, which would silently overwrite one letter with another. The segment is `m_{sha256(messageId)[:16]}`, or `u_{ulid}` when the message has no `Message-ID` at all. The verbatim value is recorded in `metadata.json`.

**An inline forward stores the whole outer HTML body.** The plain-text part can be cut cleanly at the end of the quoted header block. The HTML part cannot: the boundary is per-client markup — Gmail's quote container, Outlook's border-top rule — and a slicer that guesses wrong truncates a letter without saying so. Until that markup is catalogued the way the separator table was, an inline forward's `bodyHtml` is the entire forwarded message including the forwarder's own note. That is an honest record of what arrived, the raw MIME is archived regardless, and only owners can post inline forwards in the first place.

**Treat the inner message as its own MIME namespace.** Clients disagree on what they do to an embedded original: Outlook desktop re-encodes it under its own boundary strings, while Outlook web and Gmail both preserve the sending client's original boundaries verbatim inside the `message/rfc822` part — and because Gmail generates outer boundaries in the same format, the inner and outer strings differ only in their tail. Anything that keys off boundary naming — or that assumes inner boundaries resemble outer ones — works on one client and fails on the next. Descend through the part tree the parser gives you rather than pattern-matching boundary strings.

**An inline forward cannot yield an instant.** The quoted header block is rendered text, not headers: it carries no timezone, so the time shown is the forwarder's local wall clock, and a relative in another zone produces a different string for the same message. Precision varies too — Gmail and Outlook web print minutes, Outlook Android prints seconds, and Outlook desktop rounds to the nearest minute, quoting `8:21 PM` for a message sent at `20:20:39`. Gmail separates the time from the meridiem with `U+202F` NARROW NO-BREAK SPACE rather than a space, so splitting on ASCII whitespace loses the meridiem entirely. `originalDate` from an inline forward is therefore approximate, and the calendar-day half of the dedup gate is only as reliable as the forwarder's timezone.

**Unfold headers before reading any of them.** Outlook folds `Message-ID` onto a continuation line, so a line-oriented read of the field returns empty — and `originalMessageId` is the primary dedupe key, meaning the failure surfaces as every message from that client looking like a first arrival.

**`message/rfc822` is not a reliable marker for the embedded original.** Outlook Android's forward-as-attachment labels the original `application/octet-stream` with a `.eml` filename and base64-encodes it whole, so a scan by part type finds no embedded message where every other client supplies one — while the payload is a complete 191,970-byte RFC 5322 message carrying the missionary's `From:` and its original DKIM signature. Candidate parts are any attachment whose decoded bytes open with parseable header lines; the declared type only orders the candidates.

**Decode part filenames as RFC 2047, and expect them split.** Gmail names the `message/rfc822` attachment after the original subject, so a non-ASCII subject yields an encoded-word `filename=` — broken across two adjacent encoded words, with the `.eml` extension itself divided between them (`…=2Eem?= =?UTF-8?Q?l?=`). Reading the parameter literally produces a filename containing raw `=?UTF-8?Q?` text; decoding each encoded word in isolation without rejoining them loses the extension. Outlook Android splits the same way in `Windows-1252` (`…ponchada.?= =?Windows-1252?Q?eml?=`), dividing the name at the dot instead, so neither the charset nor the split point is predictable.

**Anchor inline-forward detection on the quote container, not the wrapper around it.** Gmail web and Gmail Android emit byte-identical forwarded content inside `<div class="gmail_quote gmail_quote_container">` and differ only in the compose wrapper preceding it — `<div dir="ltr"><br><br>` against `<div dir="auto"></div><br>`. With an empty forward body those twelve characters are the entire difference between the two captures. A matcher keyed on the wrapper passes one client and fails the other for no structural reason.

**Separator detection runs on decoded parts, never on raw bytes.** Outlook desktop base64-encodes both the plain-text and HTML parts, so the raw message contains no readable markup at all: a scan for `cid:` or for a forward separator returns nothing, while the decoded HTML holds `cid:ii_msb8f3it0` and Outlook's separator, a `<div style="border:none;border-top:solid #E1E1E1 1.0pt;…">` rule nested in `<div class="WordSection1">`. That markup shares nothing with Gmail's quote container, so the separator table is per-client and each entry is matched after decoding.

**Every encoded word carries its own charset and encoding.** Outlook web writes the subject as `=?Windows-1252?Q?…=97…?=` where Gmail uses UTF-8, and Outlook desktop emits `=?utf-8?B?…?= =?utf-8?Q?…?=` — base64 and quoted-printable in adjacent words of a single header. Inferring either attribute once per header instead of once per word yields mojibake on one client or the other. Part bodies vary independently of the headers: Outlook web and Outlook Android label their text parts `charset="Windows-1252"`, so UTF-8 cannot be assumed anywhere. Forward prefixes differ as well — Outlook writes `Fw:`, Gmail `Fwd:`, and `subjectNormalized` strips both.

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

**An empty normalized field never matches.** Gmail's *forward as attachment* composes with no subject unless the forwarder types one, so `Subject:` arrives present and empty — and a photos-only forward produces an empty `bodyHead100` the same way. Two such forwards from one relative on the same day both normalize to the empty string, match trivially, and the second letter is discarded as a duplicate of something it does not resemble. An empty normalized field is unmatchable, not a value.

| Field | Normalization |
|---|---|
| `subjectNormalized` | Iteratively strip leading `Re:` / `Fw:` / `Fwd:` tokens **and** any `[…]` bracketed prefix (e.g. `[EXTERNAL]`, `[SPAM]`) until neither pattern matches; collapse internal whitespace; lowercase. |
| `bodyHead100` | Strip quoted-reply lines (`^>`), strip signature blocks (from `-- \n` or the first `Sent from my …` line onward), collapse whitespace, lowercase, take the **first 100 characters**. |

No similarity scoring, no weights, no threshold.

**`bodyHead100` normalizes the plain-text part, never tag-stripped HTML.** Delivery paths rewrite HTML bodies — Exchange Online injects a `<meta http-equiv="Content-Type">` element at the top of the HTML part, so one message delivered two ways produces two different HTML byte streams and two different stripped prefixes. The `text/plain` alternative passes through untouched. A dedup key derived from HTML would miss duplicates for no reason other than which mail system relayed them.

**Why exact match rather than fuzzy scoring.** Weighted similarity scoring (Jaro–Winkler over normalized subject and body, with a tuned cutoff) would be solving a problem the hard gates have already eliminated. Missionaries write **once a week**; after requiring an exact sender match *and* an exact calendar-day match, the candidate set is almost always empty, and when it isn't, the two messages are either byte-similar re-forwards of one letter (both normalized fields match trivially) or genuinely different messages sent the same day — a second letter with more photos, say — where subject and opening line differ obviously. There is no middle ground for a similarity score to adjudicate. Exact matching is a fraction of the code, has no calibration surface, and fails in the safe direction: a missed duplicate is a visible extra post an owner can delete in one click, whereas a false positive silently swallows a real letter.

**Upgrade path.** Raw MIME is archived permanently, so if real-world data ever shows duplicates slipping through, we can reintroduce scoring and re-run it across all history without asking anyone to resubmit.

**Storage of truth.** Dedup does not use a separate Azure Table. `rendered/{slug}/posts.json` already contains every field the check needs (`originalMessageId`, `originalFrom`, `originalDate`, `subject`, `bodyHead100`), so ingest just loads that blob and scans it in memory. `bodyHead100` is **stored** rather than computed, because the full plain-text body is no longer kept at all (see [Data model](#data-model-postsjson-entry)) and those hundred characters were the only thing dedup ever read out of it. `subjectNormalized` is still computed on the fly against the 0–2 candidates that pass the sender+date gate — a cheap transform of a field that is already present.

**Concurrency.** A parent bulk-forwarding several weeks of letters is a normal usage pattern, so ingests for a single slug arrive in bursts. Handled with **optimistic concurrency on `posts.json`**:

1. Ingest loads `posts.json` and records its ETag. (On the very first message for a slug the blob doesn't exist yet — write with `If-None-Match: *` so two simultaneous first messages can't both create it.)
2. Runs the dedup check against the loaded posts.
3. If duplicate: send the courtesy ack, done. Nothing written to `raw/` or `rendered/`.
4. If new: append the post skeleton in memory, `PUT` back to blob with `If-Match: <etag>`, then write `raw/{slug}/{msgId}/`, then enqueue render.
5. On `412 Precondition Failed` (a sibling ingest committed between our load and our write), restart at step 1. On the retry the newly-committed sibling post is now visible, so if it *was* a duplicate of ours we'll correctly ack instead of appending.

`raw/` is only written after the ETag write succeeds, so a lost race never leaves an orphaned raw folder to clean up. At weekly-per-missionary cadence — even with occasional 5–10-message bulk-forward bursts — collisions are infrequent and each retry is cheap (one JSON fetch + one hash compare). If contention ever becomes measurable, a blob lease gives stricter serialization.

**On dedup hit:** don't create a new post. Send a courtesy acknowledgment reply (see [Notification preferences](#notification-preferences)) unless suppressed for that user. We deliberately do not track who else has forwarded a given message — the courtesy reply is the only outward signal, addressed to the current forwarder alone. A `who-forwarded-what` history would be data we collect but never use.

**Post ordering:** posts are sorted by the **original `Date:` header**, not `receivedAt`. Forwards land in their correct historical position in the timeline. `receivedAt` is retained on each post for audit and for a "Recently added" ribbon in the reader UI.

### Email ingestion — Cloudflare Email Routing

**Decision: Cloudflare Email Routing with an Email Worker.** Six providers were compared on inbound handling; see [docs/email-options.md](email-options.md). Three properties decided it:

1. **A failure is an SMTP error, not a lost letter.** Every webhook-based provider accepts the message first and then tries to hand it to us. Cloudflare's handler runs *inside the SMTP transaction*, so a failure returns a temporary error and the **sending** server retries for days. Gmail, Exchange Online, and Proofpoint all do this correctly.
2. **Inbound is unlimited, free, and uncapped.** No daily limit, no monthly limit, and no shared allowance with outbound.
3. **There is no public endpoint to defend**, and it never traverses Static Web Apps, so the **30 MB SWA request-size limit does not apply**. A webhook-based ingest would sit directly under that ceiling.

**Resend was seriously evaluated and rejected on the second point.** Its metadata-only webhook is the most elegant inbound design of the six and would have kept everything on one runtime — but its Free plan counts *received* mail against a 100/day allowance shared with outbound, and **its behavior when that cap is exceeded is documented nowhere**. Bulk-forwarding an entire mission's back catalogue in one sitting is an explicitly supported scenario, and it lands squarely on that limit. An undocumented failure mode on the one operation most likely to be performed with irreplaceable mail is not a risk worth $0. See [email-options.md](email-options.md#bottom-line) for the full comparison; Resend remains the designated fallback.

**Setup:** MX on the apex of `pdayletters.com` points at Cloudflare, with a catch-all route bound to a single Email Worker. The `to` field is read only to select a verb (`post@` vs `claim@`), never a destination.

#### The Worker must be almost too dumb to fail

The Worker does exactly two things:

1. Stream `message.raw` verbatim into `inbox/{ulid}.raw`, stamping the SMTP envelope sender and recipient as blob metadata.
2. Enqueue `{ulid}` on the ingest queue.

No parsing, no classification, no slug resolution, no ACL lookup, no dedup, no `posts.json` read, no outbound email. All of that happens in a **separate queue-triggered ingest Function** where a failure is retried from durable storage and eventually dead-lettered for inspection rather than lost.

**The envelope is the one thing the Worker must capture, because nothing downstream can recover it.** The address a message was delivered to exists in the SMTP transaction, not in the message: a missionary who BCCs the site sends a letter whose `To:` header names their family and never mentions `post@` at all — which is exactly the [`direct` path](#message-classification) the design depends on, not an edge case. The Worker is the last component that can see it, so `message.to` and `message.from` are written as `x-ms-meta-envelopeto` and `x-ms-meta-envelopefrom` alongside the blob. Both are sender-controlled and both are percent-encoded before becoming HTTP headers, since an embedded newline in a metadata value is header injection.

Reading the verb (`post@` vs `claim@`) then belongs to the ingest Function, which has the envelope available and can log a rejection when the local-part is neither. The Worker still makes no decision about it — an unrecognised recipient is stored and dropped downstream, not refused at SMTP, because refusing would tell a prober which addresses exist.

The reasoning is the same as it would be for a webhook, but the payoff is larger. If the blob write fails, the Worker throws, Cloudflare returns a temporary failure to the sending MTA, and that server still holds the only copy and will try again. **There is no window in which the message has been accepted and then lost.**

**Consequences worth noting:**

- The Worker holds Azure credentials at Cloudflare's edge. Use a **narrowly scoped SAS granting write-only access to the `inbox` container and add-only access to the ingest queue**, stored as a Worker secret and rotated on a schedule. It must not be able to read `rendered/`, and it must not be able to delete anything. This is the sharpest edge of the design: a credential that lives outside Azure, so scope it as if it will leak. **The landing zone is a separate container rather than a prefix inside `raw/` precisely so this is expressible** — a blob service SAS can be scoped to a container or a single blob, but not to a prefix, so `raw/_inbox/` would have meant handing the Worker write access to the entire permanent archive. Back both tokens with **stored access policies**, so a leak can be revoked by deleting the policy instead of rotating the account key and breaking everything else at once.
- **An SMTP retry produces a second ULID and therefore a second `inbox` blob.** Retries are not idempotent at this layer, unlike a provider-assigned message ID would be. That is acceptable because deduplication happens downstream on `Message-ID` in the ingest Function, where it has to exist anyway to handle the same letter forwarded by two different relatives — but it does mean `inbox/` will occasionally hold duplicates, and nothing before the ingest Function should assume otherwise.
- `inbox/` accumulates payloads for messages that are ultimately rejected. A lifecycle rule deletes `inbox/` blobs after 30 days; accepted messages are copied into `raw/{slug}/{msgId}/` by the ingest Function and are unaffected.
- Rejected mail therefore *is* briefly on disk. This is a deliberate trade: 30 days of quarantined spam in a private container is a much smaller cost than permanently losing a real letter to a parser bug.
- **Cloudflare rejects unauthenticated mail before the Worker ever runs.** An inbound message must pass SPF *or* carry a valid DKIM signature; failing both is refused at SMTP. This is free spam filtering and it shrinks what the classifier has to defend against — but it also means a legitimate forward from a badly-configured old ISP account can be bounced without us seeing it. It fails visibly, as a bounce to the sender, rather than silently, which is the property that makes it acceptable.
- **Cloudflare supports ARC**, attaching the original authentication results when it forwards. That is worth knowing for the classifier, which reads `Authentication-Results` rather than computing verdicts itself.
- **The verdicts are already on `message.raw` when the Email Worker runs.** Measured against a live send from `missionary.org`: the message the Worker received carried `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=missionary.org header.s=google …; dmarc=pass header.from=missionary.org policy.dmarc=quarantine`, plus `Received-SPF` and an `ARC-Authentication-Results: i=2` seal. The classifier can therefore read verdicts rather than compute them, and `mailauth` is needed only for re-verifying an embedded original's own DKIM signature.
- **The ingest queue carries the ULID as plain text.** Confirmed end to end: the Worker's Put Message body reaches the queue unencoded, so the trigger must not assume base64.
- **Two traps in that header, both confirmed against live mail.** It carries **two `spf=` results** — `spf=none` for the HELO identity, then `spf=pass` for the envelope sender — so a first-match read reports a failure for a message that passed; results must be selected by `ptype.property`. And in any specimen taken out of a delivered mailbox the *topmost* `Authentication-Results` belongs to the receiving provider, not to Cloudflare, so the header is selected by authserv-id rather than position. Acceptance keys on `dmarc=pass` plus `header.from` alignment, never on SPF, which forwarding breaks by design.
- **Message size ceiling is 25 MiB**, above which Cloudflare rejects at SMTP and the sender gets a bounce from their own provider. Gmail caps outbound attachments at 25 MB, so Gmail senders hit their own limit first. It fails visibly rather than silently, which is the property that matters.
- **`setReject()` is deliberately not used for spam.** A permanent SMTP error tells a prober which addresses exist. Unrecognized senders are accepted and dropped silently by the ingest Function — SMTP rejection is reserved for messages we genuinely cannot store.
- Workers Free imposes CPU and memory limits on email handlers that a 25 MiB stream could plausibly exceed. Move ingest to **Workers Paid ($5/mo)** before real letters depend on it.
- **Worker telemetry goes to Workers Logs, not App Insights.** This is the real cost of a second runtime, and it is worth naming plainly: the first component to touch every message reports somewhere nothing else does. Nothing in Azure will tell you the Worker is failing.

### Missionary routing

**Path-based on the canonical domain**: `pdayletters.com/{missionary-slug}` (see [Domains](#domains)).
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

### Storage layout

Single storage account, cool-tier by default (photos rarely re-read after posting).

```
inbox/                                 Landing zone. Verbatim inbound
  {ulid}.raw                           payloads awaiting processing.
                                       30-day lifecycle rule. A separate
                                       container, not a prefix in raw/, so
                                       the Worker's SAS can be scoped to it
                                       and reach nothing else.

raw/                                   Preserved archive. Write-once by
                                       convention; container-level
                                       soft-delete + versioning enabled.
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

books/                                 Journal Publish output. Built on
  {missionary-slug}/                   demand, reconstructible from
    {book-id}/                         rendered/. See Journal Publish.
      interior.pdf · cover.pdf
      manifest.json                    Posts + photos included, provider,
                                       order id
```

Plus one **Storage Queue** (`ingest`) carrying `inbox` ULIDs from the Email Worker to the ingest Function, and one (`render`) carrying accepted `{slug}/{msgId}` pairs to the render Function.

**`raw/` is an internal asset and is never handed to anyone.** No API route serves it, and it is not in the offline export. Its whole purpose is *reprocessing* — re-rendering history when the sanitizer or the forward extractor improves, re-running `inbox/` after a classifier fix, and standing as the DMARC-verified evidence of authorship behind an [ownership dispute](#the-60-day-cliff). Every one of those is something the service does *to* `raw/`, not something a user reads out of it.

That restriction is what lets the rest of the design be simple. `rendered/` is the published surface, and everything with a rule attached — sanitization, hidden posts, an owner's retroactive anonymization — is enforced there. A downloadable `raw/` would silently reopen all three: it is unsanitized HTML, it contains posts an owner has hidden, and it still holds the name they removed.

**Two things that are not exceptions.** The [full-resolution photo download](#photo-handling) reads a raw *attachment* and re-emits it EXIF-stripped — a derivative of one photo, not the message. And an owner can [restore a post's original text](#restoring-the-original), which re-renders from `raw/` into `rendered/` — the content becomes visible, but through the sanitizer and the normal read path, and only by an act that discards their own edits.

**Attachment filenames are never used as path segments.** Blob names are flat strings in which `/` creates virtual directories, so a crafted filename like `../rendered/elder.smith/posts.json` would escape the intended prefix and overwrite live data. Each attachment is stored as `{nn}-{safe-name}`, where `nn` is its MIME part index and `safe-name` is the original filename stripped of path separators, `..` sequences, control characters, and leading dots, then truncated. The unmodified original filename is recorded in `metadata.json`, so nothing is lost for display. It is re-sanitized again wherever it reaches a client — currently the `Content-Disposition` header on the full-resolution download — since a filename that was safe as a blob name is not automatically safe as a header value.

**Photo IDs are content hashes** — `p_{sha256(bytes)[:12]}`. This is what actually makes the render function idempotent: a re-run produces identical IDs and overwrites identical blobs instead of orphaning the previous set. It also dedupes repeated images for free (mission logos, a photo the missionary resends), which shrinks both storage and the offline export.

Plus two Azure Tables in the same storage account:

- **`users`** — `PartitionKey = "user"`, `RowKey = lowercased email address`. Identity columns: `displayName`, `authProvider` (`google` | `microsoft`), `firstSeenAt`, `lastSignInAt`. Preference columns: `postAckEmails`, `dedupeAckEmails`, and `digestFrequency` (see [Notification preferences](#notification-preferences) and [New-letter notifications](#new-letter-notifications) for defaults, which differ by sender type); additional per-user preferences are just additional columns as they arrive. State columns: `claimEmailSentAt` and `claimEmailCount`, driving the tapering re-invitation schedule for a missionary whose own letters created a pending site — kept here rather than in `claim.json` so the schedule survives a pending-site purge and recreation.
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
  "bodyHead100": "…",                        // first 100 normalized chars — dedup gate only
  "hidden": false,                           // owner-only visibility — filtered server-side
  "editedBy": null,                          // owner email of the most recent edit — owner-visible only
  "editedAt": null,                          // timestamp of that edit; never shown to readers
  "originalMessageId": "<CAB=…@mail.missionary.org>",  // dedupe key when available
  "originalFrom": "elder.smith@missionary.org",
  "photos": [
    { "id": "p_9a2c3f81b447", "width": 4032, "height": 3024 }
  ],
  "linkedPhotoServices": ["googlePhotos"],   // body links an album we can't archive; [] when none
  "sourceRawPath": "raw/elder.smith/{msgId}/message.eml"
}
```

The original `Date:` header keeps its offset rather than being normalized to UTC. Missionaries write from all over the world, and the local calendar day is both the value the dedup gate keys on and the one readers actually mean when they say "the letter from the 6th."

**No `ingestDomain` field.** An acknowledgment email could name the address the sender wrote to, but acks are composed at ingest time when that value is already in hand, so storing it on the post buys nothing. It's logged to App Insights instead, matching how client type and DKIM results are handled.

**`linkedPhotoServices` is a list rather than a bool**, because the two services it distinguishes have opposite prospects: a Google Drive link is fetchable in principle and a Google Photos album is not, so collapsing them would erase the only part of the observation worth recording. See [Photos that arrive as links](#photos-that-arrive-as-links-not-attachments).

**No full `bodyText` field either.** Carrying both `bodyHtml` and a plain-text twin put every letter in the reader payload twice, and nothing needed the second copy: [search](#search) can strip tags in the browser, dedup only ever read the first hundred characters, and the offline export and printed book both render from `bodyHtml`. So the plain-text body is dropped and `bodyHead100` — the one slice with a real consumer — is stored on its own. Roughly a 40% cut to `posts.json`, which is also the search index and the offline bundle.

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

**Why this rather than SAS tokens.** Because SWA injects the authenticated principal, the Function performs no token validation of its own — base64-decode a header, read an email address, check a list. There is no SAS to mint, no expiry to track, no client-side refresh logic, no CORS configuration, and no bearer token that can be forwarded to someone off the ACL. At this volume the extra hop costs effectively nothing: a page view pulling ten ~300 KB WebP renditions moves ~3 MB through a Consumption Function, and photo responses carry `Cache-Control: private, max-age=3600` so repeat views are served from the browser cache.

**Photos are cached for an hour; `posts.json` is not.** Renditions are content-addressed, so a photo URL's bytes never change and holding them is free. `posts.json` is the one thing here that *does* change — a letter arrives, an owner hides or edits one — and giving it a lifetime turned out to be actively harmful rather than merely stale: the owner's edit form is filled from that payload, so a cached copy meant a saved edit came back looking like it had never happened, and the *next* edit silently reinstated what the first had removed. A normal reload does not help, because it revalidates the document while happily serving `fetch()` results from cache; only a hard refresh did, which is not a thing to ask of anyone. It now carries `private, no-cache` with a **weak ETag salted with the caller's role** — weak and salted because the bytes are a projection of the blob rather than the blob, and one version of the file is a different response to an owner than to a reader. Revalidation costs a round trip and normally returns `304`.

**Writes carry `If-Match`.** The ETag guard on `posts.json` stops two writes interleaving on the server, but it cannot see the older and quieter problem: a form composed against a copy of the site that has since moved on, then saved back whole. That is not a race — it is a perfectly orderly write of stale data, and only the client knows it is stale. The reader sends the ETag it loaded, and a write composed against a superseded version is refused with `412` and a message telling the owner to reload. Enforced only when offered, so a client that does not know about it is not broken by it.

**Upgrade path, if it's ever needed.** If egress through Functions or added latency ever shows up in telemetry, swap to a **user-delegation SAS** scoped to `rendered/{slug}/` and minted once per session after the same ACL check. Bytes then come straight from Blob Storage. Not built now: it adds complexity for performance nobody has asked for.

**Private content delivery is Functions-mediated, and Functions on Consumption scale to zero.** The first API call a reader makes after sign-in is `/api/content/{slug}/posts.json`, which pays a ~1–3 s Node cold start on a site nobody has visited for a while. Photos are unaffected — they can't be requested until `posts.json` has returned, by which point the app is warm. Static Web Apps authentication is handled by the SWA platform rather than by a managed Function, so signing in does *not* pre-warm anything; `posts.json` is the warm-up. Given a weekly visit cadence this is acceptable, and `Cache-Control: private, max-age=3600` on photos keeps repeat views of the heavy bytes off the Function entirely. `posts.json` itself revalidates on every load — a conditional request that usually returns an empty `304`, which is the cheap half of the round trip but still pays the cold start.

**Standard tier does not, on its own, fix this.** Supporting Google auth forces Standard (custom identity providers aren't available on Free), but SWA *managed* functions still run on Consumption at any tier — Standard raises limits, it doesn't add always-ready instances. What Standard buys is the **escape hatch**: it permits a linked backend, so the API can be moved to a separately-deployed Function App on Flex Consumption with always-ready instances if telemetry ever justifies the extra resource and cost. Note that ingest is unaffected either way — the Email Worker runs at Cloudflare's edge and has no cold start.

**A keep-alive ping is rejected.** A five-minute timer would burn roughly 100,000 executions a month to save a second or two on a weekly visit, and it would hide the cold start from telemetry rather than remove it — so the first signal that the API is too slow would be a complaint rather than a metric. The one or two seconds on first load is accepted as the cost of a scale-to-zero backend; the linked backend above is the fix if it ever matters.

**The offline export is unaffected.** It's an owner- or reader-initiated download of content they're already entitled to, packaged as plain files.

### Photo handling

- **Archive (raw/):** originals preserved byte-for-byte, EXIF intact, filenames preserved. Never modified.
- **Site display (rendered/):** EXIF stripped (including GPS), re-encoded to WebP in two sizes:
  - `large.webp` (~2400px longest edge) — post-view display **and** full-screen viewing. Sized to cover 4K/5K desktop monitors and high-DPI tablets.
  - `thumb.webp` (~400px) — album grid.
- **Album view:** aggregated grid across all posts for a missionary; each thumb links to the post it belongs to.
- **Full-resolution downloads:** served on-demand by a small Function that reads the raw attachment, strips EXIF in-flight, and streams it back as JPEG. Downloads are rare enough that on-demand generation is cheaper than storing an EXIF-stripped copy of every photo. This is the one place a client receives bytes derived from `raw/`, and it is a single photo re-emitted through a transform — not the message, its HTML, or its headers. It is subject to the same ACL check and hidden-post filter as `/api/photo/`.
- Because raw is preserved, we can always reprocess (different sizes, HEIC → WebP, face detection later) without asking the missionary for anything.

**Why WebP over JPEG for the renditions?** WebP compresses photos ~25–35% smaller than JPEG at visually-equivalent quality, which shows up in three places we care about: post-page load times over cellular, the size of the offline archive zip ([Phase 5](#phase-5--offline-archive-export) — a 2-year mission's ~1000 photos, ~400–500 MB as WebP against ~600–700 MB as JPEG), and monthly Blob egress. Compatibility isn't a concern in 2026: every modern browser, iOS 14+, Android, and standalone photo viewers open `.webp` natively. The raw archive stays in whatever format the phone produced (almost always JPEG), so JPEG is always available upstream — used by the on-demand download endpoint and by the photo-book PDF generator in Phase 11.

#### Photos that arrive as links, not attachments

Missionaries with more photos than an email will carry link a shared album instead of attaching them. **Both of the first two real letters ingested did exactly this**, carrying the same `photos.app.goo.gl` album link alongside their attached photos — so this is ordinary behavior, not an edge case, and it will recur.

**Nothing about it is dangerous, and nothing about it works.** The link renders as an `<a>`, never an `<img>`: a remote image cannot survive [sanitization](#content-sanitization), so no third party ever serves bytes into a letters page and no reader's IP leaks to anyone. What the reader gets is a working hyperlink to photos **we do not hold**. That is the actual problem, and it is a quiet one — the link dies whenever the album owner deletes it, changes its sharing, or abandons the account, leaving link rot inside an archive whose central promise is permanence.

**Fetching a Google Photos album is not possible, at any price** (verified August 2026). This is worth recording precisely, because the obvious remedy — give the service its own Google account and have families share the album with it — sounds reasonable and cannot work:

- **The shared-album API was removed on 31 March 2025.** `sharedAlbums.get`, `.join`, `.leave`, `.list`, `albums.share`, and `albums.unshare` now return `403 PERMISSION_DENIED`, and Google's own migration table lists them with **"Scopes remaining: None."** There is no permission anyone can grant, because there is no API left to call.
- **What remains of the Library API reads app-created data only** (`photoslibrary.readonly.appcreateddata`). Media we did not upload ourselves is invisible to us.
- **"The Google Photos APIs don't support service accounts."** Every call requires a token from an interactively-consented human, which rules out unattended ingest independently of the point above.
- **The Picker API — the only surviving read path — is interactive by construction.** Create a session, hand a `pickerUri` to a person, poll until they finish selecting. It cannot be framed, cannot be pointed at an existing album link, and picks from the signed-in user's own library rather than from a share. Any app touching these APIs must also pass OAuth verification review.

**Google Drive is a different product with a different answer, and the naive idea works there.** A Drive URL contains the resource's own API identifier — `drive.google.com/file/d/{FILE_ID}/view`, the legacy `open?id={FILE_ID}`, or `drive/folders/{FOLDER_ID}` enumerated through `files.list` — so a regex recovers the ID and `GET /drive/v3/files/{id}?alt=media` returns bytes straight into the existing transcoder. Drive **does** support service accounts, so sharing a file or folder with `…@project.iam.gserviceaccount.com` grants unattended access with no human in the loop. The contrast is exactly this: a Drive link addresses a *resource*; `photos.app.goo.gl/…` addresses a *share*, and the API that resolved shares is the one Google deleted.

**Photos is not a view onto Drive, so Drive access does not reach a Photos album.** This is worth stating because it is the obvious next hope, and because it *used to be true* — the two products cross-synced until Google separated them on 10 July 2019. Three things establish the separation, in ascending order of how hard they are to argue with:

- Google's own [change notice](https://support.google.com/photos/answer/9316089): *"When you upload or delete photos in Google Drive or Google Photos, changes won't reflect in the other product,"* and *"Once items are copied into Photos, items aren't connected between the two products."*
- The Drive v3 [`files.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) `spaces` parameter now accepts only `drive` and `appDataFolder`. It previously accepted `photos` — that removed value *was* the mapping, and it is gone. (A vestigial `drive.photos.readonly` scope is still listed on that page; with the space removed there is nothing left for it to address.)
- **Storage is double-counted.** Copying an original-quality item from Drive into Photos makes it *"count towards your storage in both products."* Google bills the same photo twice because it is stored twice, which no shared-backing-store arrangement would do.

**Confirmed directly against the real account** rather than inferred: the album from Isaac's letters is not visible anywhere in `drive.google.com` and is reachable only from `photos.google.com`. Even setting storage aside, the link would not decode — `photos.app.goo.gl/{key}` is an identifier in Photos' *share* namespace, not a Drive file ID, and no documented function maps one to the other.

**It is still not built, for three reasons in descending order of weight:**

1. **No evidence the problem exists.** Every observed link so far is Photos, and zero are Drive. Building the Drive path today would be speculation with a credential attached.
2. **It adds a third vendor**, in the form of a Google Cloud project and a service-account key in Key Vault. That is [a cost to weigh, not a veto](#azure-resource-plan) — but this particular dependency clears the bar badly, because the vendor being depended on is the one that just deleted the API this section exists to document.
3. **The compliance question is unresolved.** `drive.readonly` is a restricted scope; a service account acting as itself shows no consent screen and so probably escapes OAuth verification review, but that is unverified and must be confirmed before anything is built on it.

**What is built instead is detection, which is cheap and generates the missing evidence.** Ingest flags a published post whose body links `photos.app.goo.gl`, `drive.google.com`, or a bare `photos.google.com` album, and records which. That is already the same signal that identifies an oversized send stripped of its photos, so it costs one regex and earns a real answer to *how often does this happen, and to which service* — the input this decision actually lacks.

**The cheapest fix is not code at all.** Onboarding text should ask for photos attached to the email rather than linked, because attachments are archived permanently and links are not. Gmail's Drive-insert dialog even offers **"send as attachment"**, which converts a link into a real attachment we already handle perfectly. One sentence of guidance solves this at the source for most people.

**Scraping the public share page is rejected.** The `photos.app.goo.gl` URL resolves without authentication, so it is technically reachable — but it is automated access outside the API and against Google's terms, it rests on markup that can change without notice, and it is an indefensible way for a service built around careful handling of other families' data to obtain that data.

### Search

**Client-side MiniSearch, index built in the browser.** The reader fetches `posts.json` and calls `addAll(posts)` on load. There is no prebuilt index artifact.

**Why no prebuilt `search-index.json`.** A serialized MiniSearch index stores the inverted index *plus* the stored fields, so it is typically **larger than the source text it indexes** — and the reader still needs `posts.json` to display anything, so emitting one would ship roughly twice the necessary bytes. Skipping it also avoids an artifact, a build step, a file to keep in the export bundle, and a class of staleness bug: the post-edit path in Phase 9 would have to rebuild the index or leave edited posts unsearchable by their new text.

**Search text is derived from `bodyHtml` in the browser.** Posts carry no plain-text body (see [Data model](#data-model-postsjson-entry)), so the reader strips tags from the sanitized HTML as it indexes. The HTML has already been reduced to a small allowlist by the render function, so this is a trivial transform rather than a parsing problem, and it costs a few milliseconds across a full mission. **Hidden posts are never indexed**, because they never reach the client at all — see [Editing and hiding posts](#editing-and-hiding-posts).

**Size in practice.** A full two-year mission is ~104 letters at roughly 500–1500 words each — about 1 MB of JSON now that the duplicate plain-text body is gone, or **~150–250 KB compressed**, comparable to a single photo. Indexing that many documents takes milliseconds. In exchange, list rendering, post navigation, and search all become instant with no further round-trips, and the same code path works offline in the exported archive.

**If first paint ever needs to be faster**, the fix is to split by payload role rather than reintroduce an index: emit an `index.json` of id, date, subject, snippet, and thumbnail id (~8 KB compressed) for immediate list rendering, and fetch `posts.json` in the background to enable search a moment later. Not built now — revisit if `posts.json` exceeds ~5 MB uncompressed or if measured first paint on cellular is poor.

### Access control

- **Auth:** Static Web Apps **Standard** with Google and Microsoft identity providers. **Google is required, not optional** — `@missionary.org` is Google Workspace, so the missionary population is Google-native, and personal Gmail is the most likely identity for the family members around them too. Google is a *custom* provider in SWA, which is available only on Standard; that tier was already the plan's baseline for other reasons, so this adds no cost.
- **Model:** per-missionary allowlist keyed on the authenticated user's email address.
- **Roles per missionary's letters site:**
  - `owner` — full admin rights: invite, revoke, add/remove other owners, and edit, hide, or delete any post — see [Editing and hiding posts](#editing-and-hiding-posts). **Multiple owners allowed** so the missionary can share admin duties (typically with a parent) without a separate role tier. There is always at least one owner — the "remove owner" action refuses if it would drop the count to zero.
  - `reader` — invited viewer. Read-only for site content; can also download the offline archive and order a printed book for themselves (see [Post-mission archive](#post-mission-archive) and [Journal Publish](#journal-publish)).
- **A service-wide `operator` role exists outside this model** — not per-site, not stored in any ACL, and not grantable from the web UI. See [Service operators](#service-operators).
- **`verifiedMissionary` owners cannot be removed by others.** An owner entry created through the `claim@` flow (see [Ownership and the 60-day window](#ownership-and-the-60-day-window)) carries this flag and is removable only by that owner themselves. It's the tiebreaker that makes a genuine ownership dispute resolvable instead of a race.
- **Owners on `missionary.org` are warned continuously.** Any owner identity on that domain stops working 60 days after the missionary returns home, so the admin UI shows a persistent banner until a non-`missionary.org` owner exists — see [The 60-day cliff](#the-60-day-cliff).
- **Invitations:** an owner enters one or more email addresses and a role; each is added to `acl.json` **and sent an invitation email carrying a signed link**, and access binds to whatever identity accepts through that link. See [Invitations](#invitations).
- SWA route rules enforce that `/{missionary-slug}/*` requires an authenticated user whose email is in that slug's ACL. API calls check the same ACL server-side.
- **Forwarding is gated by the same ACL.** Anyone on a missionary's ACL can forward historical missionary emails to `post@pdayletters.com` and have them land on that missionary's site.
- **Inline forwards are owner-only.** Readers can forward, but only with the original message attached, because inline forwarded text carries no proof of authorship — see [Message classification](#message-classification).

### Service operators

Several things this document already promises have no actor: deleting a site after an abuse report, resolving an ownership dispute the [60-day window](#the-60-day-cliff) has already closed on, re-rendering history after a sanitizer or extractor fix, reprocessing a message the classifier got wrong, or walking a stuck owner through an invitation they can't get to work. All of them require acting on a site the actor is not a member of.

**An operator is an owner on every slug, resolved at authorization time.** The shared ACL check behind [Private content delivery](#private-content-delivery) returns `owner` for an operator on any site, and **nothing is written to that site's `acl.json` or to `memberships`**. That single choice does most of the work: operators never appear in an owner's invitee list, never populate a site switcher or the signed-in root redirect (an operator reaches a site by typing its URL), and the owner admin UI needs no operator-specific variant, because an operator opening `/{slug}` *is* an owner as far as the authorization layer is concerned. Adding or removing an operator is one config change instead of a fan-out write across every site in the service.

**The operator list is configuration, not data** — an `OPERATOR_EMAILS` Function app setting, expected to hold one or two addresses. A privilege this broad must not be grantable through the interface it grants: if operators lived in a blob or a table, one compromised operator account could quietly add a second and make the escalation permanent and self-sustaining. As a setting, adding an operator requires Azure control-plane access — a separate credential, separately recorded in the Azure Activity Log. There is deliberately no UI for editing it.

**Operator status is not consulted by the email path.** Ingest resolves forwarding rights from `acl.json` alone, so being an operator does not confer the ability to publish into a stranger's site by email. A `From:` header — even a DMARC-passing one — is a far weaker identity signal than a signed-in session, and there is no scenario in which an operator needs to author content on someone else's site rather than administer it.

#### What operators can do that owners cannot

- **Delete any site**, through the same permanent-deletion path an owner uses (see [Post-mission archive](#post-mission-archive)) — one code path, one retention story. The confirmation additionally requires a **reason string**, recorded in the audit log, because it is the only part of the action that cannot be reconstructed from the data afterward.
- **Inspect or purge a pending site** before its window lapses — the disposal route for a site that spam created, and the only way to look at one at all, since pending sites render nothing and have no ACL.
- **Reprocess raw mail service-wide.** `raw/` is preserved specifically so history can be re-rendered after a sanitizer or extractor fix, and `inbox/` retains misclassified messages for 30 days so they can be re-run after a classifier fix (see [Building blind](#building-blind)). The operator is the actor who delivers on both. Owners can re-render a single post on their own site — see [Restoring the original](#restoring-the-original) — but a sweep across every slug is not an owner-shaped action, and `inbox/` belongs to no site at all.
- **See service-wide message flow** — the `/manage/last-received` view spans every slug, so it can never be an owner-facing page.

#### What operators deliberately cannot do

- **Remove a `verifiedMissionary` owner.** That flag is what makes an ownership dispute resolvable instead of a race, and an operator who can clear it with a click reduces the protection to decoration. An operator settling a dispute adds an owner or deletes the site — both drastic, both logged — rather than quietly unseating the one person who proved control of the mailbox.
- **Add or remove operators**, per the config-not-data rule above.
- **Act invisibly.** See below.

#### Operator access is visible and logged

"Private by default" is a headline goal and an operator is the standing exception to it, so the exception is made observable rather than left implicit:

- **Every operator action against a site they don't belong to emits an `OperatorAction` event** to App Insights — actor, slug, action, timestamp, and the reason string where one was collected. **Reads are logged, not only writes.** Reading a family's letters is the privilege that matters most here, and a write-only audit trail would miss exactly that.
- **A persistent banner appears on any site where the operator is not an ACL member:** *"You are viewing this site as an operator. This access is logged."* This guards against the likelier failure by far — an operator forgetting which hat they are wearing and editing a real family's post — and makes the boundary visible while they work.

Disclosing this access to owners in plain language belongs with the terms-of-use work rather than in the product UI, and is tracked in the follow-up issue alongside the dispute-resolution process it makes possible.

**Operator routes live under `/manage/*`, never `/admin/*`.** The Azure Functions host reserves the `admin` route prefix for its own management API; Functions registered there deploy without complaint and then 404 at runtime.

### Signing in and getting around

Access *policy* is above. This section is the reader-facing half: how someone who is entitled to a site actually arrives at it, and what they see when something goes wrong.

#### The root page is the front door

**Anonymous, it is public.** `pdayletters.com/` serves an unauthenticated landing page — what the service does, the `post@pdayletters.com` address, and *"Are you a missionary? Email `claim@pdayletters.com` from your `@missionary.org` address to claim your site."* Everything on it is generic; no slug, no name, no content. Without it there is no way to discover `claim@` at all, since every letters site is auth-gated and the `post@` path is deliberately silent.

**Signed in, it redirects.** A visitor with an authenticated session goes straight to the most recently updated site they belong to; from there the [site switcher](#switching-between-sites) reaches any others. A signed-in user with *no* memberships gets a short explanation rather than the marketing page: *"You're signed in as jane@example.com, but that address doesn't have access to any letters site yet. Ask whoever set it up to invite this address."* That message earns its place — the likeliest support question this service will ever get is someone invited at one address signing in with another, and it answers that question without a human involved.

#### Invitations

**Shipped 2026-08-05**, and this section is annotated below wherever the built thing differs from the designed one. Each difference has a reason; the largest is that a pending invitation does not live in `acl.json` at all.

**An invitation is an email, not just an ACL write.** Adding an address to `acl.json` grants access but tells nobody; without a message, the invitee can reach the site only if the owner separately sends them the URL.

**Adding people is bulk by default.** The realistic first act after claiming a site is inviting a dozen relatives in one sitting, so the field accepts a pasted list — commas, semicolons, newlines, and `Name <addr@example.com>` forms — rather than one address at a time. One-at-a-time entry turns the single most common setup task into a dozen round-trips through a confirmation dialog. **Shipped.** The addresses are sent one at a time rather than in parallel, which the design did not specify: sequential sending is what makes the read-then-check daily cap exact on this path, and it is what lets a refusal name the address it refused. Addresses that fail stay in the box so a typo can be corrected and resent without re-pasting the ones that worked.

**Each invitee gets exactly one email**, self-originated from `no-reply@mail.pdayletters.com` (see [Domains](#domains)) — the only class of outbound mail the service sends to someone who never wrote to us. **It ships from `P-Day Letters <hello@pdayletters.com>`** per the sending-identity decision in [Phase 8](#phase-8--outbound-mail-and-preferences), where `no-reply@` was rejected for trading one silent failure for another. Three things make mailing a stranger acceptable, and all three are requirements rather than niceties:

- **It names the human who invited them**, in the subject and the first line: *"Sarah Smith invited you to read Elder Smith's letters."* Unattributed, it is a message from an unfamiliar domain, about a named person, asking you to click a link — indistinguishable from phishing. **Shipped**, and it is the one subject line in the service that names anybody, deliberately breaking the rule the rest follow.
- **It is never repeated.** No reminders, no nudges. An unaccepted invitation stays unaccepted. Anything else turns a text box on a web page into a mechanism for repeatedly mailing arbitrary strangers. **Shipped**, and now held by arithmetic as well as by intention — see the daily cap in [Phase 9](#phase-9--owner-admin-invitations-and-operators).
- **It carries the one-click opt-out**, which here means "never invite me to anything again" and is honored ahead of any future invitation to that address. **Shipped**, and built here rather than in Phase 8 as planned, because this is the mail that needs it: an invitation is the only message the service sends to somebody who did not write to us first, so it is the only one whose recipient has no other way to make it stop. The opt-out is **global rather than per archive** — "stop emailing me" is not "stop emailing me about Elder Example", and making somebody repeat it once per family would honor the request technically while defeating it. The address to suppress is **inside the token's signature**, so the endpoint never takes anybody's word for whom to silence; without that, the opt-out form would be a way to stop a grandmother ever receiving the invitation her family is about to send. It is **spent by `POST`, never `GET`**, per the scanner problem in [Phase 7](#phase-7--onboarding-pending-sites-and-the-claim-flow). An owner who invites a suppressed address is told so plainly rather than being allowed to believe mail went out; that discloses, to an owner who guesses an address, that its holder opted out, which is a smaller cost than leaving the owner chasing a message that is never going to arrive.

**The link is a signed invitation token, and that token — not the typed address — is what grants access.** Same HMAC mechanism as the claim link, scoped smaller: single-use, bound to one slug and one role, 30-day expiry. **Shipped at 14 days, not 30.** A claim link is generous because it is the only route to letters that would otherwise be deleted; an invitation can be reissued in ten seconds by somebody already signed in, so the cheap thing is to let it lapse. **The token also carries a signed `purpose`,** which the design did not ask for: without it a claim link and an invitation were separated only by which table their hash was looked up in, which is incidental rather than arithmetic, and the day a third kind of link appears the separation has to be re-derived rather than read.

It exists because the ACL is keyed on email address, but **the address an owner knows for someone is frequently not the address behind their Google or Microsoft account.** A parent invites `grandma@aol.com`; she signs in with the Gmail account on her tablet; the ACL check fails, and neither she nor the parent can see why. The same applies to every relative with a work address, an old ISP address, or a shared household mailbox.

Binding on acceptance avoids that entirely: whatever identity signs in *through the invitation link* is written to the ACL. The typed address is **where to send the invitation**, not **who the person must prove they are**. Both are recorded — `invitedEmail` alongside the bound identity — so the owner's list still shows the address they typed. **Shipped.** The list shows the invited address only when it differs from the one they signed in with; echoing the same string twice tells the owner nothing and makes the row harder to read, and the row's job is to be checkable at a glance before somebody presses Remove.

**The security trade is small and consistent with the claim link.** A forwarded invitation email lets the recipient in — the same property the claim link has, at lower stakes, since the claim link grants ownership of the whole site while an invitation grants read access to letters the forwarder could already read. Single-use binding caps exposure at one identity, and an owner can revoke. **One stake is higher than that sentence allows**, and it was missed here: an invitation can carry the *owner* role, so a forwarded one hands over more than read access. It is also why the sanitizer now strips our own links out of published letters — see [Never publishing our own access links](#never-publishing-our-own-access-links).

**ACL entries carry an acceptance state** — `invited` (no identity bound yet) or `active` — surfaced in the owner's admin list, so *"Grandma says she still can't see it"* is answerable by looking: the owner sees the invitation was never accepted and resends, which issues a fresh token and invalidates the old one. **A resend is owner-initiated and manual**, which is what keeps "never repeated" true — the service never decides on its own to email an invitee a second time.

**Shipped differently, and this is the largest divergence in the section.** Pending invitations live in their own `invites` table, partitioned by slug; `acl.json` is written only on acceptance. Putting a state column on an ACL entry means a row exists in the ACL for somebody who has no access — in the one file `resolveRole` reads. Access control and pending-offer state would share a data structure, so every future reader of that file has to remember that some rows do not count, and one forgotten check is a stranger reading a family's letters. The owner's list still shows both states; the API assembles them from the two sources rather than reading one.

- **The row key is the token's hash, never the token.** An owner listing invitations is shown the hash, which is a handle for revoking one and not a credential for accepting it.
- **Revoking leaves a tombstone rather than deleting the row**, which the design did not anticipate needing. Two things rest on the row surviving: the daily cap counts issued rows, so revoking cannot buy another send; and a withdrawn token stays explicitly refused rather than merely unrecognised. Its holder still gets the same answer as for a link that never existed.
- **Resend shipped 2026-08-05**, having been dismissed here as *"revoke-then-invite-again is the same two writes with one more click"*. That was wrong about the audience rather than about the writes: the owner who needs it is the one whose invitation went to spam, and asking them to withdraw the invitation they are trying to repeat is asking them to do the frightening thing first. Four properties, each of which the obvious implementation gets wrong:
  - **The address comes from the stored row, never from the request.** A resend that accepts an address is a second, quieter path to mailing strangers — one with no bulk-parse in front of it and a different name in the logs.
  - **It counts against the daily cap.** A resend that did not count turns one invitation into an unbounded send loop, which is a worse shape than the revoke loop the tombstone closes, because it needs no second control.
  - **The old token is tombstoned and a new one issued.** Reissuing the same token would leave an invitation resent on day thirteen expiring tomorrow; the owner would have done the thing that was supposed to help and made no difference.
  - **Expired invitations are not resendable**, because `listInvites` filters them out and the owner therefore never sees one. The remedy is to invite again, which costs the same.

  The new row is written before the old one is tombstoned. If the second write fails, the owner has a live invitation they cannot see, which is recoverable; the other order can leave no invitation at all and a mail already sent. The second email says it is a repeat and says the earlier link has stopped working, because the likeliest thing the recipient does is open whichever of the two they find first.

#### Switching between sites

A grandparent with two grandchildren out, or a friend of several missionaries, belongs to more than one ACL. **There is deliberately no dashboard page.** For the overwhelming majority — who have exactly one site — it would be pure friction between them and the letters.

Instead the site header carries a **switcher, rendered only when the signed-in user has more than one membership**, listing the other missionaries by display name as direct links. One membership and nothing appears at all; the UI is exactly as it is today. Populated from a single `memberships` partition query (see [Storage layout](#storage-layout)).

Together with the signed-in root redirect (above) this makes discovery complete without adding a page: land on any site you belong to, reach all the others from there. Both pieces are necessary — every site is auth-gated and the root is generic to anonymous visitors, so a reader who loses the URL otherwise has no way back in.

#### Sessions expire, and re-authenticating must be invisible

Static Web Apps issues its own session cookie at the edge; the app never sees a token, only the decoded `x-ms-client-principal` header. **Its lifetime is not configurable and Microsoft doesn't publish it** — it is commonly observed at around eight hours. Plan for "about a working day," and design so the exact number doesn't matter.

**MSAL is not a lever here.** SWA managed authentication is platform-level and server-side, with no hook for extending or refreshing the session. Reaching for MSAL would mean abandoning SWA auth entirely and validating tokens inside every Function — which forfeits the central simplification behind [Private content delivery](#private-content-delivery), where the API performs no token validation of its own. Not worth it to lengthen a session.

So the answer is not a longer session, it's making the return trip cost one click. Two flows, because expiry surfaces in two different places:

- **A deep link — the case that matters most.** Family members reach their letters site by bookmark or by a link someone texted them, so an expired session lands on `/{slug}` and, with no handling, yields a bare `401`. A [`responseOverrides`](https://learn.microsoft.com/azure/static-web-apps/configuration#response-overrides) rule on `401` redirects to the sign-in chooser carrying `post_login_redirect_uri=.referrer`, so after signing in they arrive at the page they originally asked for.
- **The root page.** `/` is anonymous-allowed, so an expired session simply sees the public landing page rather than being redirected — correct behavior, since it's also what a genuine stranger must see. It therefore needs a visible **Sign in** button, pointing at the chooser with `post_login_redirect_uri=/`. Sending them back to the *root* rather than to a site is deliberate: root already knows how to resolve a signed-in visitor to their most recent site, so the destination logic lives in exactly one place and can't drift.

**Sign-in is a chooser page, not a direct provider link.** SWA sign-in routes are provider-specific (`/.auth/login/google`, `/.auth/login/aad`), and with two providers there is nothing sensible to guess — picking wrong strands a user on an account that isn't on any ACL. A small `/login.html` page presents both buttons and threads `post_login_redirect_uri` through to whichever they choose.

**Built and measured, ahead of Phase 9.** The question flagged here — whether SWA's `.referrer` substitution survives the hop through an intermediate page — was tested against the live site and the answer is **no**: an anonymous request to `/isaac.backman` produced `302` to `/login.html?post_login_redirect_uri=.referrer`, the token unsubstituted. A redirect-based chooser would therefore have silently dropped every deep link. The fix is to stop redirecting: the 401 override **rewrites** to `/login.html` instead, so the address bar keeps the URL that was asked for and the page reads `location.pathname` directly. That is strictly better than the fallback suggested here — it needs no platform magic at all, and it keeps the status code an honest `401`, which matters because `app.js` distinguishes an expired session by exactly that code. The query-string form is still accepted, because `app.js` uses it when a session expires mid-visit.

**The return address is validated before use.** It arrives in a query string, so it is attacker-controlled: anyone can send a family member a link to our own sign-in page carrying any destination they like, and it is handed straight to the platform as a post-login redirect. Unvalidated that is an open redirect wearing our domain and our sign-in page — the most credible phishing page an attacker could be handed. It must be a rooted path, and must reject `//host` and `/\host`, both of which browsers resolve to a different origin despite the leading slash.

#### Signed in, but not on the list

A valid session on a site you don't belong to is a `403`, and it needs different handling from the expired-session `401` above: signing in again does not help, because the problem isn't *that* you're signed in but *which* account you're signed in as. It covers the mismatched-address case from [Invitations](#invitations), a revoked reader following an old bookmark, and someone opening a link that got forwarded around a ward.

The page names the identity being rejected and what to do about it: *"You're signed in as `grandma.smith@gmail.com`, but that address doesn't have access to Elder Smith's letters. If you were invited at a different address, sign out and sign in with that one — or ask whoever invited you to add this address."* A **Sign out and try another account** button points at `/.auth/logout` with a redirect back to the same path.

Naming the signed-in address is what makes the page useful — without it, "wrong account" and "not invited" look identical, and they have opposite remedies. The missionary's display name appearing here to an unauthorized visitor is a deliberate and very small disclosure: they already hold the slug, which is the missionary's own email local-part, so the name is not news.

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

A single invitation is too few. A missionary who adds `post@` to his BCC line, skims the reply on a busy P-day, and never acts on it loses nothing — the rolling window preserves every letter — but six months later there are twenty-six letters unrendered and unviewable, his family has read none of them, and his only contact from us was one message half a year ago. Everything is preserved; no site exists.

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

**The sign-in identity is almost always a personal account, and that's the point.** `@missionary.org` is Google Workspace, and the tenant may block third-party OAuth entirely (see [External constraints](#external-constraints)) — so in practice a missionary claiming a site signs in with their personal Gmail or Microsoft account. **The stronger reason is that they have no credential to offer.** Access to that mailbox runs through the Church's own sign-in and a link across into Gmail; the missionary never types a Google username or password, and so has nothing to hand an OAuth consent screen even where the tenant permits one. That makes a personal account not merely the likely path but very nearly the only one. This is exactly the outcome the 60-day window demands, and it arrives for free rather than by persuasion. It is also why the claim step exists at all: the mailbox proves *who you are*, the OAuth sign-in establishes *what identity holds the role*, and decoupling them means ownership never inherits the mailbox's expiry.

**Claiming never demotes anyone.** In the overwhelmingly common case the missionary simply wants access to their own letters while a parent continues to run the site, and evicting the parent would be hostile. Multiple owners are already supported, so the missionary joins the existing set.

**Verified-missionary owners are protected.** The ACL entry created through a `claim@` link is flagged `verifiedMissionary: true` and **cannot be removed by any other owner** — only by that owner themselves. Without this, a genuine dispute degenerates into an owner-removal war that whoever clicks fastest wins. With it, a missionary can join a site claimed by someone with no business owning it, remove that person, and not be removed back.

#### The 60-day cliff

Per [External constraints](#external-constraints), `@missionary.org` access ends **60 days after a missionary returns home**. `claim@` therefore stops working entirely at that point, and so does `direct` publishing.

This is exactly backwards from when disputes tend to surface — "I found out years later there's a site about me" is the case that matters most and the one the mechanism cannot serve. Four responses, none of which depend on the mailbox still being alive after the fact:

1. **Bind a personal account, not the missionary one.** The claim link should be followed with a personal Google or Microsoft account. Ownership then survives indefinitely, because the ACL entry is keyed on an identity that doesn't expire. The `claim@` reply says this in as many words — and if the Church tenant blocks third-party OAuth, it's the only option that works anyway.
2. **Handle the `@missionary.org` owner case defensively, not as an expected path.** If the tenant *does* permit third-party OAuth, a missionary may reach for their Church Google account and end up with an owner identity that dies with the mailbox. Any owner on that domain triggers a persistent, non-dismissible banner in the admin UI: *"This account stops working 60 days after you return home. Add a personal account as an owner now."* It stays until a non-`missionary.org` owner exists. Cheap to implement, and it costs nothing if the case never occurs.
3. **Nudge the existing owner, continuously.** The owner admin view carries a standing prompt — *"Is [missionary] set up on this site? They can only claim it while their `@missionary.org` address works."* This costs nothing, requires no detection of mission end, and resolves the non-adversarial 99% long before the window closes. If `returnDate` is set in `profile.json` (see below), the prompt escalates in the weeks either side of it; otherwise it escalates after ~4 weeks of no new letters. False positives are cheap — it's a banner, not an email.
4. **A human dispute path is the only real backstop after 60 days.** Nothing automated can verify a returned missionary's identity once the address is gone. The archive itself is the evidence: every `direct` message in `raw/` carries a DMARC-verified `@missionary.org` origin, which proves authorship long after the mailbox is deactivated. The means of acting on a decision exists — a [service operator](#service-operators) can add an owner to any site or delete it outright — so what is missing is the policy governing when to do so, which belongs with the terms-of-use work: tracked in the follow-up issue, and a prerequisite before the service is offered to anyone outside a known circle.

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

- **`postAckEmails`** — bool. Sends a short *"Posted — thanks!"* reply on every successfully published letter. **Default `true` for everyone except `@missionary.org` senders, where it defaults to `false`.** The two groups have genuinely different needs: a forwarder is actively managing a site and needs to know their forward landed, whereas a missionary adding `post@` to their weekly email should never hear from us again. A weekly ack is 104 interruptions across a mission, each one consuming scarce P-day computer time, in service of a site somebody else is watching: **the missionary isn't monitoring the site; the owner is.** If letters stop arriving, a parent notices first. Missionaries who *want* confirmation can turn it on from the settings page or the `claim@` reply.
- **`dedupeAckEmails`** — bool, default `true`. Sends a *"we already have this one — thanks!"* reply when a forwarded email is de-duplicated against an existing post.
- **`digestFrequency`** — `monthly` | `weekly` | `off`. One email summarizing what's new across every site this address belongs to. **Chosen by the user at first sign-in rather than defaulted**, with `monthly` preselected; `off` for `@missionary.org` rows, which are created by ingest and never sign in. See [New-letter notifications](#new-letter-notifications).

**Neither ack fires for messages promoted out of a pending site**, and this is a property of the promotion path rather than a per-user preference — there is nothing to opt into. See step 6 of the [onboarding flow](#flow).

Every generated email carries a one-click opt-out for its own category ("Don't email me every time a letter posts"). The link is a **signed token** hitting a Function endpoint that flips the flag directly, with no sign-in required. It cannot point at the authenticated settings page instead, because acks go to `@missionary.org` senders who typically have no Google or Microsoft identity and cannot sign in at all. The claim flow already requires an HMAC signing service, so this reuses it rather than adding one.

**Half of this shipped early, in Phase 9, as the invitation opt-out.** The token format, the `optouts` table, the `POST`-only endpoint, the RFC 8058 headers, and the page at `/optout` all exist and are described under [Invitations](#invitations). What shipped is deliberately *not* per-category: it is a single global "stop emailing this address", because the only mail that existed to opt out of was the one kind nobody asked for. When digests and acks arrive, the per-category flags described here go on the `users` row and the global suppression stays above them as a veto — a preference is a choice about which mail to receive, and an opt-out is a statement about receiving any, and collapsing the two would let a preferences page quietly re-subscribe somebody who said no.

An authenticated settings page at `/settings` still exists for ACL members who'd rather toggle preferences directly. It is not per-slug — these are columns on one `users` row spanning every site the address belongs to.

**Mail-loop protection.** Because the service replies to essentially every inbound message, a misconfigured autoresponder on the other end could ping-pong indefinitely. Three guards: outbound acks carry `Auto-Submitted: auto-replied` (RFC 3834); inbound messages carrying `Auto-Submitted` other than `no`, or `Precedence: bulk`/`list`/`junk`, are never acked; and no ack is ever sent to an address on one of our own ingest domains.

Acks double as an end-to-end smoke test for the send-and-receive email pipeline: they exercise outbound send from `no-reply@mail.pdayletters.com` (the single canonical sender — see [Domains](#domains)), the token-signing service, and the `users` table read/write path.

### New-letter notifications

As designed so far, the service publishes letters to a website and never tells anyone a new one exists. Grandparents are a core audience and will not remember to check a URL. Without a nudge, the archive gets built for readers who never arrive.

#### The digest

**One email per person, not per site.** A grandparent with two grandchildren serving gets a single message covering both. Per-site digests would put two near-identical emails in the same inbox on the same morning, and the count grows fastest for exactly the people most likely to find it tiresome.

**Monthly by default, weekly on request.** Monthly is rare enough that nobody reaches for unsubscribe, and a three-week-old letter is not stale in an archive people read in batches. Weekly matches the publishing cadence, for the parents and grandparents who want it.

**The preference is asked, not assumed.** On a user's **first sign-in** — accepting an invitation, or claiming a site — a single question appears alongside the rest of that flow: *"How often should we email you when new letters arrive? Monthly / Weekly / Never."* Monthly is preselected, and the whole thing is one tap.

Asking beats either default. Opting everyone in silently makes the service's first act toward a new grandparent an unrequested subscription, which is what trains people to unsubscribe from a domain entirely. Defaulting to off means the feature doesn't exist for most people. Asking at first sign-in costs one line in a flow the user is already completing attentively.

**`@missionary.org` addresses never see the question** — their row is created by the ingest path rather than by a sign-in, they typically have no Google or Microsoft identity to sign in with at all, and they wrote the letters. `off`, for the same reason `postAckEmails` is.

**Changeable afterward** from `/settings`, and from the one-click opt-out link every digest carries.

**If nothing published, nothing sends.** No "no new letters this month" email, ever. An empty digest is pure noise, and it would arrive most reliably during exactly the stretch — a transfer, a sick week, a missionary between areas — when the family is already uneasy about the silence.

**Contents,** per new post: missionary display name, subject, first two lines, one thumbnail, and a direct link. The link lands on `/{slug}/…` and SWA auth gates it normally; an expired session gets the [401 flow](#sessions-expire-and-re-authenticating-must-be-invisible), which is why that had to exist first. Hidden posts never appear, because the digest reads the same filtered payload as everything else.

**Mechanically it is machinery that already exists.** A `digestFrequency` column on the `users` row, a timer-triggered Function, one `memberships` partition query per recipient, `lastPostAt` on each membership to decide what's new, the same self-originated sender as other generated mail (`no-reply@mail.pdayletters.com`, per [Domains](#domains)), and the same one-click HMAC opt-out the acks carry. The only genuinely new things are a column and a schedule.

#### Text messages (stretch)

An opt-in mobile number per user, texted a short line and a link when a letter posts. Nobody misses a text — that is the entire argument for it, and it is a good one.

Held as a stretch goal because it is the only feature in the plan that leaves the current cost and compliance envelope:

- **It isn't free.** Outbound SMS carries a per-message fee and requires a rented number, against a service budgeted at ~$12–15/month in total.
- **US A2P messaging requires sender registration** (10DLC or toll-free verification) before carriers deliver reliably. That is an application with a review, not a config toggle.
- **`STOP` handling is mandatory**, which means an inbound message path, per-number opt-out state, and honoring it permanently — a second unsubscribe system running alongside the HMAC email one.
- **It introduces phone numbers**, the first genuinely sensitive personal data the service would hold. Everything stored today is an email address the person already handed to a mail provider.

**If built, it is per-post rather than digested.** A monthly text is pointless; immediacy is the only thing SMS offers that email doesn't. Default off, always, with the number collected on the settings page and confirmed by a round-trip code before anything is sent to it.

### Editing and hiding posts

Both capabilities are asserted in [Access control](#access-control) and in [Moderation / quarantine](#moderation--quarantine). This is what they actually do.

#### Editing

An owner can change a post's **subject** and **body** — copy-editing, fixing a typo, or retroactively removing a name, an address, or an identifying detail about someone else that the missionary wrote in a hurry and would not have written on reflection.

- **Edits are made against the rendered post, never the raw message.** `rendered/{slug}/posts.json` is rewritable by definition; `raw/` is not. So every edit is undoable — see [Restoring the original](#restoring-the-original) — and the archive continues to hold what the missionary actually wrote.
- **Edited HTML passes through the same sanitizer as ingested HTML.** An owner is a trusted user, but a *compromised* owner session pasting a `<script>` tag into a body would otherwise write stored XSS directly into the file every reader downloads. One sanitizer, one code path, no trusted-input exception.
- **Edits are ETag-guarded**, like every other write to `posts.json` — see [Concurrency](#extracting-and-de-duplicating-forwards). Two owners editing different posts on the same Saturday morning is ordinary.
- **No "edited" badge, but the edit is recorded.** `editedBy` and `editedAt` are written on the post — not to police owners, who are trusted, but so that *"why does this letter not match the one in my inbox?"* has an answer years later when nobody remembers. **Owner-visible only**, and never rendered to readers: the intended uses are typo fixes and anonymization, and flagging "this post was edited" to readers would advertise the anonymization it exists to perform — exactly backwards. Only the most recent edit is kept; a full revision history would be a second copy of every letter to store, filter, and delete, and `raw/` already holds the original.
- **Dedup fields are not editable.** `originalFrom`, `originalDate`, `originalMessageId`, and `bodyHead100` are derived from the source message. If an edited subject changed the value dedup keys on, a later re-forward of that same letter would stop matching and quietly reappear as a second post.

#### Tidying the markup mail clients invent

**The sanitizer removes empty blocks as well as dangerous ones.** Measured across the first 24 stored letters, every single one arrived carrying between 10 and 19 empty `<p>` elements and one empty `<div>` — 340 in total, about 7% of the stored body, and a blank line each on screen. None of it was written by anyone; it is spacing a mail client expressed twice.

- **It happens in `sanitizeBody`, so ingest and editing get it from the same place.** A tidying pass that only ran on ingest would be undone the first time an owner corrected a typo, and one that only ran in the reader would leave the offline export and the print book untidied.
- **The rule is "no text, no picture, no rule".** A block is removed only when its entire subtree renders nothing: `frame.text` is empty after trimming (`&nbsp;` has already been decoded to a space by then), it has no surviving image, and it contains no `<hr>`. Anything that puts a mark on the page keeps its wrapper.
- **`<hr>` needs explicit bookkeeping and is the one real trap here.** A horizontal rule contributes no text and is not counted as a media child, so `<div><hr></div>` reads as empty and the naive rule takes the rule down with the wrapper — verified, not assumed. `exclusiveFilter` runs innermost-first in closing order, so recording the output position of each surviving rule and asking whether any sits at or after the block's own position distinguishes a rule *inside* the block from one merely near it.
- **Only `p`, `div` and `span`.** An empty `<li>` still consumes a bullet and an empty `<td>` still holds a column open; removing either changes the shape of something the writer built deliberately.
- **Nesting resolves in one pass**, because a parent's text is the text of its whole subtree — a `<div>` wrapping nothing but empty paragraphs is judged empty in the same sweep that removes them. No loop, no fixpoint.
- **It is idempotent**, which is not a nicety: every owner edit re-sanitizes an already-stored body, so a pass that kept changing its own output would rewrite letters forever and defeat the ETag guard's purpose.

**Existing letters are re-tidied with `functions/tools/tidy-posts.js`,** which replays the sanitizer over `posts.json` through the same ETag-guarded commit path an owner edit uses. It reports by default and needs `--apply` to write. Its safety net is that it compares the visible words and the image count of every body before and after and **refuses the whole run** — not just the offending letter — if either changed: a body that loses words means the sanitizer did something the tool did not predict, and the rest of the batch is no longer trustworthy either. `bodyText`, `editedBy` and `editedAt` are deliberately left alone, because no words changed and nobody edited anything; putting a person's name on a maintenance pass would corrupt the one provenance record [Editing](#editing) exists to keep honest.

#### Never publishing our own access links

**A claim link and an invitation link are bearer credentials, and forwarding one to `post@` publishes it.** The service mails these to people, and people forward mail — including, at exactly the wrong moment, the mail that says *"here are your letters"*. That forward lands in the ingest pipeline, is classified, rendered, and written into `rendered/{slug}/posts.json`, where the link is readable by everybody the archive is shared with. An invitation can carry the **owner** role, so a reader who found one could promote themselves. Shipped 2026-08-05.

- **It happens in `sanitizeBody`, for the reason the tidying pass gives**, and additionally at both plain-text points — `bodyText` in ingest, and render's text-to-HTML path — because a text-only letter never reaches the sanitizer at all. A control covering only the HTML path is one forwarded plain-text mail away from useless.
- **It matches any host, not `PUBLIC_BASE_URL`.** Pinning it to the configured base URL would make the most security-critical module in the system depend on an app setting, where getting the setting wrong disables the control silently and nothing looks broken. Host-agnostic fails the other way: the worst case is a dead link in somebody's letter.
- **The match stops at whitespace, which is sufficient rather than sloppy.** A token is far longer than a mail client's wrap column, so a plain-text forward will break it across lines and only the first chunk matches. That chunk is the base64url payload, and removing the beginning of a token leaves a remainder that cannot be verified and cannot be reassembled from what survives.
- **The quoted-header probe is redacted too, and this is the trap.** The header-block rule compares the plain-text letter against the sanitized HTML. Redacting one side and not the other turns a match into a miss for any letter that opens with a link — and a miss there means the block holding the letter is mistaken for a header block and dropped. A leak-prevention control causing data loss would have been a bad trade made silently.
- **It is forward-looking only, and `tidy-posts.js` cannot clean up behind it.** Redacting a link changes the visible word count, which is exactly the condition that tool refuses the whole run on. That guard is correct and should not be weakened for this; retro-cleaning an already-published link needs its own pass.

#### Restoring the original

**This is the only way anyone gets at what the missionary originally wrote, and it is destructive.** An owner picks **Restore original** on a post; the render Function re-runs against `raw/{slug}/{msgId}/` and overwrites `subject`, `bodyHtml`, and the `photos` array with a fresh render.

It is not a read of `raw/` — nobody is handed the `.eml`. It is a *rewrite of the rendered post from it*, so the text arrives through the sanitizer and the ordinary ACL-checked read path, exactly like a newly ingested letter. Everything in [Storage layout](#storage-layout) about raw email never leaving the service holds.

- **Every edit on that post is discarded, including edits made by a different owner.** The confirmation says so plainly and names them: *"This replaces the post with the original letter. Sarah's edits from 12 March will be lost."* There is no per-field restore and no diff to review — both would need a revision history, which deliberately doesn't exist.
- **`editedBy` and `editedAt` are cleared**, since the post once again matches what arrived.
- **`hidden` survives.** Hiding is a moderation decision about the post, not a property of its text, and a restore that silently republished a hidden letter would turn an undo button into a disclosure.
- **Idempotent, like every other render.** Content-hash photo IDs mean a restore rewrites the same blobs rather than orphaning the previous set, so restoring twice costs nothing and changes nothing the second time.
- **Owner-only, and scoped to one post on a site they own.** The service-wide version — re-rendering history after a sanitizer or extractor fix — is an [operator](#service-operators) action.

**A "view original" pane is rejected.** Showing the untouched text side by side is exactly the raw disclosure the storage rule forbids: it would hand a reader the name an owner had just removed, and it would present unsanitized HTML to a browser. A deliberate, destructive, owner-only overwrite keeps one published version of each letter and one archive nobody reads.

#### Hiding

**A hidden post is visible to owners and to nobody else.** Not to readers, not in search, not in the album, not in the offline export, not in the printed book, not through `/api/photo/`. One rule, no carve-outs.

- **Shape:** a `hidden: true` field on the post. A boolean rather than a `visibility` enum, because a third state would need a third audience and there isn't one.
- **Filtered server-side, at the API boundary.** `/api/content/{slug}/posts.json` strips hidden posts for `reader` callers before the bytes leave the Function. Client-side filtering would ship the hidden letter to the browser and trust the UI not to draw it, which is a CSS rule, not privacy. The same check gates `/api/photo/`, so a photo belonging to a hidden post cannot be pulled by URL either.
- **Owners get them, marked.** The same endpoint returns hidden posts to `owner` callers with the flag intact, and the admin view renders them dimmed with an **Unhide** action — so a post can be taken out of view without being lost track of.
- **Hiding does not affect dedup.** A hidden post keeps its slot in `posts.json` and still matches re-forwards of the same letter. Skipping hidden posts in the dedup scan would mean the next aunt to forward that email silently republishes it, undoing the moderation action with nobody aware it happened.
- **The offline export and the printed book consume the same filtered payload** the reader UI does, so neither needs its own rule and neither can drift from this one.

#### Deleting

**Delete removes the post's record from `rendered/{slug}/posts.json` and nothing else.** The `.eml` in `raw/` and the renditions in `rendered/{slug}/photos/` stay exactly where they are.

- **The photos become unreachable for free.** `/api/photo/` resolves a photo ID by scanning the posts, so dropping the record already makes them un-fetchable — there is no second place to enforce it and therefore no second place to forget. Deleting the blobs as well would be worse than useless: they are content-addressed, so a picture quoted in two letters is *one* blob, and erasing it on behalf of one post would blank it in the other.
- **It is undoable by re-forwarding**, which is the honest thing to tell an owner and is what the confirmation says. `raw/` still holds the letter; without a record in `posts.json` there is nothing for dedup to match, so the same message ingests again as new.
- **Hide is the better answer most of the time**, and the confirmation says that too — hiding is reversible in one click and keeps the letter in view for owners, where delete makes it invisible to everyone including them.
- **Deliberately idempotent.** A repeated `DELETE` reports success rather than `404`. A double-click or a retried request is the overwhelmingly likely cause, and answering the second one with an error would make a deletion that worked look like one that failed.

**Why hiding exists at all, when owners can already edit and delete.** It is the pause between them. Letters [publish immediately by design](#moderation--quarantine), so an owner who spots a problem wants it out of view *now* and wants to decide what to do about it later — when there is time to write a careful edit, or to ask the missionary what they meant. Deleting is the irreversible option and editing is the considered one; hiding lets an owner act immediately without choosing between them under pressure.

### Moderation / quarantine

**Hands-off by design.** Posts publish immediately on ingest. Owners can edit any post's subject or body, hide, or delete via a lightweight authenticated admin view (see [Editing and hiding posts](#editing-and-hiding-posts)) — that gives them everything an approval workflow would, without slowing down the common case.

Rationale: missionaries have limited P-day computer time; adding a pending-approval step defeats the "zero effort" goal. Anything an approval queue would catch is equally fixable post-publish through the standard edit/hide/delete tools — usually before family notices, since owners are typically parents already watching for new posts. If real missionaries later ask for a pre-publish gate, we'll add it in response to that request rather than in anticipation of it.

### Post-mission archive

**Nothing about the site changes when a missionary comes home.** No "read-only mode" flip, no state transition, no admin action. The letters simply stop arriving. Owners retain full edit/hide/delete rights on individual posts; anyone on the ACL can still forward historical emails that surface later (an aunt finds an old email in her inbox two years post-mission and forwards it — it lands normally). Nothing on our side needs to happen.

**The one thing that does expire is the missionary's ability to claim the site.** Their `@missionary.org` address stops working 60 days after they return, taking `claim@` with it — see [Ownership and the 60-day window](#ownership-and-the-60-day-window). Late-arriving *forwards* are unaffected, because routing reads the `@missionary.org` address out of the archived historical header rather than contacting a live mailbox; a letter forwarded in 2032 still resolves to the right slug.

**Anyone on the ACL** can, at any time (during or after the mission):

- **Download the offline archive** — one-click "Download my letters" produces a self-contained zip:
  - `index.html` — the same reader UI, but pointed at local files
  - `posts.json` — the same ACL-filtered payload the reader receives, so hidden posts are absent unless the requester is an owner
  - `photos/` — all `large.webp` + `thumb.webp`
  - Open `index.html` in any browser and it works, search included. Grandparents get their own copy without going through the owner.
  - **`raw/` is not included, at any role.** The export is a portable copy of the site, and the site is `rendered/`. See [Storage layout](#storage-layout) for why raw email never leaves the service.

- **Order a printed book** — see [Journal Publish](#journal-publish). Any ACL member can order a copy for themselves.

**Owner-only actions:**

- **Deletion is immediate to everyone, and permanent after 30 days.** An owner can delete the site and all archived content (raw, rendered, config, and per-missionary preferences). The site stops resolving at once and no ACL member can reach anything through any path; a timer purges the blobs for real 30 days later, including soft-deleted versions and snapshots. A [service operator](#service-operators) can invoke the same path on any site, with a recorded reason.

  **The promise is worded that way on purpose.** `raw/` runs with soft-delete and versioning precisely so nothing is ever lost, so a literally-instant hard delete would mean disabling the one safety net protecting the irreplaceable half of the archive. A typed confirmation catches a misclick; it does not catch an owner who meant it in the moment, or a family mid-argument. Thirty days of quiet recoverability costs nothing, and it has to be **stated plainly at the confirmation prompt** — *"Your letters stop being visible immediately and are permanently erased 30 days from now"* — because a "permanent" button that isn't is worse than an honest one.

  **A pending-site purge stays immediate.** Nothing there was ever claimed, and expiry follows 60 days of silence rather than a click, so there is no misclick to undo and no owner to change their mind.

  **Purging a version is a two-pass operation, and it is not the one you would guess.** Verified against the real account in Phase 0: `DELETE ?versionid=…` only *soft-deletes* the version, and `DELETE ?versionid=…&deletetype=permanent` returns `409 BlobSnapshotNotSoftDeleted` unless that first pass has already run. A version that is still the current version of a live blob refuses both with `403 OperationNotAllowedOnRootBlob`, so the base blob has to be deleted first to demote it. Three passes in total — demote, soft-delete, permanently delete — and skipping any of them leaves data behind while reporting success.

  **`az storage blob delete` cannot do this at all.** It has no `--version-id`, and a `?versionid=` smuggled in through `--blob-url` is *silently ignored* — the CLI deletes the base blob, exits 0, and leaves every version intact. Any purge implementation has to call the REST API directly.

  **The deletion timer needed a role the Functions had all along — this section had it backwards.** Permanent delete requires the `blobs/permanentDelete/action` data action, and **Storage Blob Data Contributor does not include it** — its data actions are an explicit five-item list. That much was right. The claim that "the managed identity holds exactly that role today" was not: checked against the live account on 2026-08-05, the Function App's identity held **Storage Blob Data Owner**, account-wide, and had done since Phase 0. The warning against granting Owner to the ingest identity was therefore not advice about a future decision. It was a description of the configuration already running.

  That matters more than a documentation error, because the ingest identity is the one that processes attacker-supplied mail. The capability this section reserved for a timer that was never built was sitting on the component with the largest attack surface, and the archive it could have erased is the one thing in the system that cannot be rebuilt.

  **The grant was deliberate, which is why it survived.** `main.bicep` carried a comment on it: *Blob Data Owner rather than Contributor: the Functions host manages its own leases and the deployment package container, which Contributor cannot do.* Microsoft's own Flex Consumption guidance says the opposite — that `Storage Blob Data Contributor` scoped to the deployment storage account is what a system-assigned identity needs. One of those is wrong and the documentation cannot settle which, so nothing here was resolved by argument.

  **Split by scope instead, on 2026-08-05.** Role assignments can target a single container, so the disputed question never has to be answered:

  - **Storage Blob Data Contributor, account-wide** — the data plane. Cannot permanently delete, so with versioning and soft delete on, anything this identity destroys is recoverable for thirty days.
  - **Storage Blob Data Owner, on `app-package`, `azure-webjobs-hosts`, and `azure-webjobs-secrets` only** — the containers the Functions host runs for itself. The host keeps exactly what it had, so the ingest pipeline could not break. None of those containers holds a letter.
  - **A custom role, `P-Day Letters Blob Purge`** — Contributor's permissions verbatim plus `permanentDelete`, version controlled as `infra/purge-role.json`. It is assigned to a **separate user-assigned identity**, `mj-id-purge`, scoped to `raw`, `rendered`, `config`, `exports`, and `pending`. Not `inbox`, which holds untouched originals and is aged out by lifecycle rule rather than by any timer.

  The result is that `permanentDelete` no longer reaches `raw/` from the internet-exposed credential under any configuration, and it was achieved without betting the ingest pipeline on whose claim about the Functions host is correct.

  **The purge identity is not attached to the function app yet, on purpose.** Both `createBlobStore` and `createTableStore` construct a bare `new DefaultAzureCredential()`, and what App Service selects when an app carries both a system-assigned and a user-assigned identity was never established — Microsoft documents `client_id` as required for multiple *user-assigned* identities and is silent on the mixed case. Attaching it before there is purge code to use it would take that risk for no benefit, and worse, if the platform silently preferred the user-assigned identity the split would be undone invisibly. It gets attached in the same change that adds the timer and pins the credential explicitly.

  **It also requires `allowPermanentDelete` on the blob service**, which is off by default and cannot be set from the az CLI — it is an ARM property, set in `main.bicep`. This is a real trade-off, not a formality: the flag is precisely what stops soft delete from being an absolute backstop against a compromised credential mass-deleting the archive. It is on because a service that promises a family their letters are erased has to be able to erase them; the compensating control is that the credential able to use it is not the one exposed to inbound mail — the [Worker's SAS](#email-ingestion--cloudflare-email-routing) cannot delete anything at all. **That sentence only became true on 2026-08-05.** Until the role split above, the identity handling inbound mail held `blobs/*` account-wide, which includes `permanentDelete`. The compensating control was described in this document for months before it existed.

  **It was on mainly for the development loop, and that reason turned out not to expire.** Through Phases 0–8 the flag's real job is letting `infra/reset-slug.ps1` wipe a test slug cleanly between fixture runs, which is worth far more than an account-wide backstop over data that is all disposable. Once real family letters exist, the calculus was expected to invert.

  **Decided on 2026-08-05: the flag stays on.** The reasoning that made it easy is a fact this document never recorded — `reset-slug.ps1` authenticates as the *signed-in user*, not as the Function App's identity. It calls `az account get-access-token` and passes `--auth-mode login` throughout. So no amount of per-identity RBAC surgery can affect the development loop; only `allowPermanentDelete` itself could, because it is account-wide and identity-independent. The two levers this section treated as one are in fact independent, which is what makes the split above worth doing on its own.

  Given that, the choice is between two ways of protecting against a stolen credential mass-deleting the archive. Turning the flag off would cost the dev wipe and force the deletion timer to hold ARM control-plane rights so it could flip the flag, purge, and flip it back — a larger blast radius than the thing it defends against, since a credential that can rewrite blob service properties can also turn soft delete off entirely. The role split addresses the same risk directly and more narrowly, by removing `permanentDelete` from the internet-exposed credential rather than from the account. What was wrong was never the answer; it was arriving at Phase 9 without noticing the choice had already been made in Phase 0 for unrelated reasons.

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

If a user specifically wants Shutterfly, the manual path is always available to them without our involvement: they open Shutterfly directly, use the offline archive export (Phase 5) to obtain their photos, and upload manually.

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
| Static Web Apps | **Standard** from Phase 0 | Web UI + auth + the HTTP API. Standard is required from Phase 3 for Google auth. | ~$9 |
| Azure Functions | Consumption, its own app | Ingest, render, pending purge timer, deletion purge timer, digest timer. **Managed functions cannot host any of these** — inside Static Web Apps, triggers and bindings are [limited to HTTP](https://learn.microsoft.com/azure/static-web-apps/apis-functions#constraints), and managed functions get **no managed identity** regardless of SKU. Background work therefore runs in a separate Function App, which reaches storage with its own identity. | ~$0 |
| Storage account | Standard **GRS**, Cool tier default | Raw archive + rendered artifacts + `users`/`memberships` tables + `ingest`/`render` queues | <$3 for years of data |
| Cloudflare | Workers Free → **Workers Paid** | DNS, Email Routing (inbound — unlimited, free, uncapped), and the ingest Email Worker | $0 → $5 |
| Key Vault | Standard | Outbound provider key, Lulu OAuth secret, HMAC token-signing key, and the Worker's storage SAS | ~$0.03 |
| Custom domains + certs | Managed by SWA | `pdayletters.com` + `www` — Standard allows 6 | $0 (certs are managed) |

**Rough total: ~$12/month through Stage 1**, rising to **~$17/month** once outbound mail (Workers Paid, $5) goes live in Phase 8. Standard was pulled forward from Phase 3 to Phase 0 deliberately: the alternative was a storage connection string sitting in application settings for the whole of Stage 1, and paying $9/month to keep a real credential out of configuration is the right trade on a service holding other families' letters. The mail provider is still deferred to the phase that needs it.

**Only two vendors — a preference, not a rule.** Everything today is Azure or Cloudflare, and Cloudflare would be in the picture for DNS regardless, so inbound mail cost no additional relationship, no additional bill, and no additional account to secure. That was a deciding factor alongside the uncapped inbound quota.

A third vendor is worth adding when it buys a capability the existing two genuinely cannot, and when losing it would be survivable. Each addition costs an account to secure, a credential to rotate and eventually to hand over, a second console to check when something breaks, and a set of terms that can change without consulting us. **That last cost is not hypothetical:** Google deleted the entire Google Photos shared-album API in March 2025 (see [Photos that arrive as links](#photos-that-arrive-as-links-not-attachments)), which is exactly the shape of failure this scrutiny exists to anticipate. So the test is whether the capability is worth the dependency, not whether the count stays at two.

**GRS rather than LRS on storage.** LRS keeps three copies in a single datacenter, which does not survive a regional loss — an awkward fit for a service whose central promise is that these letters are preserved permanently and are, for many families, the only surviving copy. The delta is roughly a dollar a month at this scale. If the cost ever matters, the right narrowing is GRS on `raw/` only (the irreplaceable data) with LRS on `rendered/`, which is fully reconstructible from `raw/`.

---

## Build plan

Two stages. **Stage 1 is a narrow vertical slice** — a real letter, forwarded by hand, readable on a site and downloadable as an offline archive. It is forward-only, single-user, and exists to put the whole pipeline under real mail as early as possible. **Stage 2 widens it** into the service the rest of this document describes.

Stage 1's development loop is *forward a real letter → look at the result → delete everything → repeat*, so it is optimized for iteration rather than for onboarding anyone. There is one site; its ACL is a hand-written file with a single `owner` entry. **Nothing in it is throwaway** — that file is the real format, checked by the real code path, so there is no temporary authorization bypass to remember to remove. The plan rejects a `public: true` flag in the reader for the same reason.

See [docs/email-options.md](email-options.md) for the vendor / pricing comparison behind the email decisions in Phase 0.

**Each phase carries a status line.** Written when the phase changes state, not in a sweep, because a status that is only ever correct on the day someone audited it is worse than none. Three values: **Shipped**, **Partly shipped** with the split named, and **Not started**. A phase that cannot start for a reason outside the code says so instead.

---

## Stage 1 — Vertical slice

### Phase 0 — Foundation
**Shipped.** Running in production on `pdayletters.com`.

- Create the Azure resource group.
- Storage account (GRS): containers `inbox/`, `raw/` (soft-delete + versioning on), `rendered/`, `config/` — **all private, public blob access disabled at the account level**. Storage Queues `ingest` and `render`. Lifecycle rule deleting `inbox/` blobs at 30 days. Set `allowPermanentDelete` on the blob service delete-retention policy — without it no version can ever be removed on demand, only aged out. The `pending/` and `books/` containers, the `users` and `memberships` tables, and the HMAC and Lulu secrets are Stage 2 and are not created yet.
- App Insights instance (for rejection logging and general telemetry).
- Key Vault for later secrets. No provider API key is needed yet — nothing sends until Phase 8. Note that **Key Vault references don't work with SWA managed Functions at all** — the Functions must call Key Vault from their own code, using the managed identity.
- **Point `pdayletters.com` at Cloudflare nameservers.** It is on Namecheap today. Do this first — MX and DKIM both depend on it, and propagation is the one step that can't be hurried. The other three registered domains are not used; see [Domains](#domains).
- Static Web App on the **Standard plan**, with `pdayletters.com` as a custom domain. **Stage 1 needs only the Microsoft identity provider**, which is built in; Google is a *custom* provider and arrives in Phase 3, before anyone outside the ACL sees content. Standard is taken from the start anyway because managed identity is Standard-only, and without one the Functions would need a storage connection string in configuration. Requesting an identity on Free fails with the misleading `SkuCode 'Free' is invalid` — on Free the `identity` property must be absent entirely, not `None`.
- Set `ACCEPTED_INGEST_DOMAINS` to `pdayletters.com` — it is the list of domains this service *receives* mail on, not the domains people forward from, so it holds one value and grows only if a second domain is ever served. Set `MISSIONARY_DOMAINS` to the real `missionary.org` — no stand-in is needed, because the letters being forwarded are genuine missionary mail. `OPERATOR_EMAILS` is a Stage 2 setting: with one site and one user, that site's own ACL is the entire authorization model.
- **Enable Cloudflare Email Routing on `pdayletters.com`**, with `post@` bound to the Email Worker. **Do not hand-write MX, SPF, or DKIM** — enabling Email Routing creates all three automatically: three `*.mx.cloudflare.net` MX records, `v=spf1 include:_spf.mx.cloudflare.net ~all` on the apex, and a `cf2024-1._domainkey` DKIM record. Cloudflare needs that SPF because forwarding *is* sending; it rewrites the envelope sender via SRS so SPF passes at the destination.
- **Bind named addresses to the Worker, and leave the catch-all forwarding to a human.** This reverses an earlier instruction to bind the catch-all itself, and the reason is that a catch-all pointed at ingest turns every stray message — DMARC aggregate reports, backscatter, spam addressed to invented local-parts — into a stored blob and a queue message that the classifier can only reject. None of it is actionable until `claim@` exists in [Phase 7](#phase-7--onboarding-pending-sites-and-the-claim-flow), and routing it away from a mailbox a person actually reads costs the one thing Stage 1 most needs: seeing what genuinely arrives at this domain. So `post@` and a `probe@` test address go to the Worker, everything else forwards. **Revisit when `claim@` lands** — that is the point at which a second named route is needed anyway, and the choice between two named routes and one catch-all becomes a real question rather than a premature one.
  **Neither the Worker nor the ingest Function inspects the recipient**, so which addresses reach ingest is purely a Cloudflare-side decision and re-pointing one requires no deploy. `ACCEPTED_INGEST_DOMAINS` is now enforced by ingest, on the `envelopeto` metadata the Worker records. It is defence in depth behind Cloudflare's routing rather than the primary control — the only thing that decides what reaches the Worker is the zone pointed at it — and it exists so that a *second* domain aimed at the same Worker is a rejection rather than a publication. **It fails open in both directions on purpose:** an empty list accepts everything, so a missing app setting cannot switch the check on; and an unreadable recipient accepts too, because it sits in front of every genuine letter and the two failures are not symmetrical — a letter published from an unexpected domain is visible and reversible, while a letter silently discarded is gone.
- **Cloudflare's inbound cap is 25 MiB and it is enforced ahead of the Worker.** Verified against the live domain: the largest real letter accepted was 25,394,245 bytes — 3.1% of headroom — and an oversized send is refused at SMTP with `552 5.3.4 Email data size exceeded`. The `5xx` matters more than the number: it is a *permanent* rejection, so the sending server does not retry and the forwarder gets a bounce naming the reason in plain language. That is the failure mode to want, and it is worth knowing it is not the one the Worker's own error path produces — the Worker throws to get a *temporary* `4xx` and a retry, but a message this size never reaches it. **Nothing in Azure records the attempt**, per the Workers Logs note in [Phase 1](#phase-1--inbound-forward-pipeline); the bounce in the sender's mailbox is the only evidence.
- **Publish DMARC by hand** — it is the one record Cloudflare does not create. Start at `p=none` with an `rua` address and leave it there through Stage 1. Cloudflare warns explicitly that *"restrictive DMARC policies can make forwarded emails fail"*, and this service is built entirely on forwarded mail, so tightening to `quarantine` or `reject` is a decision that needs evidence from `rua` reports first. **The outbound provider is a Phase 8 decision**, and its DKIM key cannot be published before it is chosen — Cloudflare's own sending uses a separate `cf-bounce` selector.
- **Mint the Worker's storage SAS** — write-only to the `inbox` container, add-only to the `ingest` queue, no read on `rendered/`, no delete anywhere, and no access to `raw/` at all. Back both with stored access policies so they can be revoked without rotating the account key. Store them as Worker secrets. This credential lives outside Azure, so it gets the narrowest scope in the system. Record its expiry somewhere you will actually see it; a silently expired SAS turns every inbound letter into an SMTP retry loop. **Verify the scope by probing it** rather than trusting the permission flags — write, read, list, delete, and a cross-container write, confirming only the first succeeds.
- Write `config/{slug}/acl.json` and `profile.json` by hand: one `owner` entry, one display name. `infra/seed-config.ps1` does this, taking the slug, owner address, and display name as arguments so no real email address is committed to the repo. The seeded owner carries `verifiedMissionary: false` — it was not established through the `claim@` flow and gets none of that flag's protection.
- **Confirm the test forwarder's domain publishes DMARC**, and add a `p=none` record if it does not. A forwarder whose domain has no `_dmarc` record classifies as `rejected` and is dropped silently — see [Message classification](#message-classification). If the `rua` address is on a different domain, that domain must also publish the `{forwarder-domain}._report._dmarc` authorization record or the reports are discarded.
- **A reset script.** Wiping a slug must be one command — `raw/{slug}/`, `rendered/{slug}/`, and the `inbox` residue, **including soft-deleted versions and blob versions**, or every iteration of the loop silently accretes storage that soft-delete is designed to keep. It is also the honest first draft of the deletion purge in Phase 9, and building it early is what surfaced how [purging a version actually works](#post-mission-archive) — three REST passes, an ARM-only account flag, and a data action missing from the role the Functions run as. `infra/reset-slug.ps1` does it; `infra/probe-reset.ps1` proves it by seeding a throwaway slug, resetting it, and asserting the containers come back empty. Keep `config/{slug}/` by default: wiping the hand-seeded ACL turns a re-ingest test into a re-seed.
- **`main.bicep` described the infrastructure for months without ever deploying it, and first ran on 2026-08-05.** The static site and the Worker already shipped themselves on a push; the template had no such path, so nothing ever forced it to be true, and it accumulated changes made directly against the live account. Infrastructure as code that is never applied is not infrastructure as code; it is a second description of the system, written in a language that makes it look authoritative.

  **Two things about `what-if` came out of the first real deployment, and both are the kind that make it untrustworthy in opposite directions.**

  - **It does not diff `siteConfig.appSettings` at all.** A `GET` on `Microsoft.Web/sites` does not return them, so `what-if` has nothing to compare and reports nothing — not a warning, not an unknown, silence. `main.bicepparam` had never set `cloudflareAccountId` or `mailAllowlist`, both of which default to empty in the template, so a deployment would have blanked `CLOUDFLARE_ACCOUNT_ID` and `MAIL_ALLOWLIST` and reported success. Because an empty allowlist means *mail nobody* by design, outbound mail would have stopped without erroring. Both are now pinned in the parameter file. **The general rule: `what-if` is silent about app settings, so they have to be diffed by hand.**
  - **Its `Modify` count is not a drift measure.** It reported 28 `Modify` before the deployment and **28 immediately after a successful one** — against a resource group that was, at that moment, exactly what the template describes. The residue is server-populated defaults the template omits (`defaultEncryptionScope`), read-only properties (`stableInboundIP`), and `reference()` expressions `what-if` cannot resolve, all reported as changes. A count that does not fall to zero after convergence cannot be read as drift; the only usable signal is the *list*, inspected property by property.

  What the deployment did fix was real: the template omitted `repositoryUrl`, `branch`, and `provider` on the Static Web App, so it proposed unlinking the GitHub repository. Those are now declared. It also proved the [role split](#post-mission-archive) is genuinely encoded rather than hand-made — all nine assignments survived a deployment that would otherwise have reverted them.

  **The gap is now closed: `deploy-infra.yml` applies the template on every push touching `infra/**`.** It authenticates by workload identity federation — GitHub mints a short-lived OIDC token asserting which repository and ref is running, and Entra exchanges it — so **no Azure credential is stored in GitHub and none appears in the expiry table in [todos.md](todos.md)**. The identity is `mj-id-deploy`, a user-assigned managed identity rather than an app registration, chosen because an app registration can have a client secret added to it later and a managed identity cannot; the safer option stays the only option.

  **The subject is not what the documentation says it is.** Nearly every example writes `repo:owner/name:ref:refs/heads/main`. GitHub's current default embeds numeric owner and repository IDs — `repo:kurtzeborn@22382549/mission-journal@1311226429:ref:refs/heads/main` — so a credential written the documented way fails with `AADSTS700213` and an error naming a subject that appears in no configuration file. Read it rather than assemble it: `gh api repos/{owner}/{repo}/actions/oidc/customization/sub` returns `sub_claim_prefix` directly. The IDs are an improvement, not an inconvenience — they survive a rename, and they cannot be inherited by whoever registers the name after a repository is deleted.

  **What that identity may do is the real question, and it is not about where a secret lives.** The template creates role assignments, which `Contributor` cannot do, so the deploy identity also holds `Role Based Access Control Administrator` at resource-group scope. Unconstrained, that means a push to `main` could grant any role to anything — including handing back the `permanentDelete` capability the split above exists to remove. Two things narrow it:

  - **An ABAC condition restricts it to the six roles this template assigns.** It cannot grant `Owner`, `Contributor`, or `User Access Administrator` to anything. The limit worth knowing: a condition can name roles but not scopes, so it constrains *which* role may be granted and not *where* — re-granting `Storage Blob Data Owner` account-wide is still expressible.
  - **Its own two grants are deliberately not in the template.** Declaring them would make every run re-assert them, which would force the condition to permit granting `Contributor` — and a workflow that can grant `Contributor` to anything is not constrained at all. So the credential that runs the deployment is not grantable by that deployment. This is the one place in `main.bicep` where leaving something out is the safer choice, and it is recorded here because it otherwise reads as an omission.

  **The workflow checks the service, not just the deployment.** ARM reporting `Succeeded` means the template was accepted, which is a weaker claim than it sounds: a blanked parameter deploys perfectly and breaks the app. The run finishes by calling `/api/optout/describe`, `/api/claim/describe`, and `/api/invite/describe` and failing on anything but `200` — three routes that between them require the Function App to have started, read its settings, and resolved a Key Vault reference.

- **The API was the last thing shipping from a laptop, and `deploy-functions.yml` ends that.** Infrastructure, the static site and the Worker all deployed themselves while the Function App — the component that reads other people's mail — was published by hand with `func azure functionapp publish`. Two things were wrong with that beyond the inconvenience. What ran in production was whatever happened to be in one working tree at the time, which no commit records and nobody else can reproduce. And the test suite gated nothing: it ran on push, reported, and had no bearing on what was deployed, so a red run and a green run shipped alike.

  **Test and deploy are jobs in one workflow rather than two workflows joined by `workflow_run`.** `workflow_run` fires when the first workflow *finishes*, not when it passes, and it resolves the code to deploy independently of the code that was tested. `needs: test` inside a single run has neither gap: the deploy job cannot start unless the tests and the audit gate both pass, and it deploys the commit they passed against.

  The deploy job runs no `npm ci`. Flex Consumption builds remotely, so the zip carries `package.json` and `package-lock.json` and Oryx installs from the lock on the platform side; installing on the runner as well would ship a `node_modules` built by the runner and leave it ambiguous which install actually ran. It authenticates with the same federated identity as the infrastructure workflow, and, like that workflow, it finishes by asking the running host to answer rather than trusting the deployment API's word that it accepted a package.

  **With no publish profile in use, basic publishing credentials had no consumer, and both were still open.** The `scm` and `ftp` endpoints each accept a username and password Azure mints for the app — the entire content of a downloaded publish profile. That pair belongs to no person, never expires, and is not revoked by anything: every copy ever pulled from the portal or an IDE stays valid. The reason it is not merely untidy is that **code deployed there runs as the app**, and the app's identity reads the storage account and resolves Key Vault references — so deploy rights are read access to every letter, reached without touching Entra, RBAC or MFA at all. Both are now declared `allow: false` in `main.bicep` rather than switched off in the portal, so the state is written down and re-asserted on every infrastructure run. A control that exists only as a checkbox somebody once ticked is one undocumented click from being untrue.

- **No dependency can change without a commit, and that was measured rather than assumed.** Both `package.json` files carry committed lock files, and every workflow that installs runs `npm ci`. The uncertain path was the Function App, which builds remotely with Oryx — nobody writes `npm ci` there, so whether `package-lock.json` is honoured is a property of someone else's build system.

  **Matching versions do not answer it.** If the lock is current, a floating `npm install` resolves to the same tree and looks identical. The test needs a package where the lock is *behind* what a floating install would choose: `@azure/storage-blob` is ranged `^12.26.0` and locked at `12.32.0`, while `12.33.0` was published on 2026-06-24 — six weeks before the live package was built. Reading the deployed `released-package.zip` out of the `app-package` container gives `12.32.0`. **A floating install would have taken the newer one, so the lock is being applied.** All ten direct dependencies match it exactly.

  The consequence is that upstream cannot break this service on its own initiative, and the residual risk points the other way — nothing floats, so nothing updates, and an advisory against something we ship would arrive as no signal at all. `.github/dependabot.yml` turns that silence into a monthly pull request, grouped, with major versions of the parsing and imaging libraries deliberately left out of the group: a major `sharp`, `mailauth`, or `postal-mime` changes what subscribers actually receive.

  One part stays outside the lock's guarantee: **`sharp` ships platform-specific native binaries as optional dependencies**, so versions are pinned but binary selection happens at install time on the build agent. Same lock, different machine, different artifact.

### Phase 1 — Inbound forward pipeline
**Shipped.** 25 real letters ingested; 13 fixtures in the corpus.

**Forward-only.** `direct` exists as a classifier branch and is covered by fixtures, but nothing exercises it until [Phase 6](#phase-6--direct-ingest).

- **Build an `.eml` fixture corpus first.** Collect real forwards of the same message from Gmail web, Gmail iOS/Android, Outlook desktop/web, and Apple Mail — both "forward inline" and "forward as attachment" — plus a BCC'd original and a message carrying `cid:` inline images. Check them into the repo as test fixtures. Nearly every hard bug in this system lives in MIME parsing, and this corpus is the only way to find them without waiting on live mail. The `direct` path is covered by a real `@missionary.org` send; hand-written `Authentication-Results` headers cover the fail and absent cases that a genuine account cannot produce on demand.
- **Every fixture carries an `.expected.json` sibling.** A specimen with no assertions attached to it is a file, not a test: it can only fail by throwing. The sibling records what the extractor must recover — `extractionSource`, `embeddedPartType`, the original's `from` / `subject` / `date` / `messageId`, attachment and inline-image counts, and the `cid` values — plus the client quirks that were verified by inspection. Values are read from the capture rather than from a parser's output, so the file describes the message instead of blessing whatever the current code happens to do. `tools/check-expected.ps1` verifies the pairing and cross-checks the structural claims against the messages.
- **Capture rich source material once, then forward it.** Only the `From:` domain and its DKIM signature require the missionary's own account — every remaining capture is a forward of a message already sitting in a mailbox, sent from whatever client is being characterized. That makes the source message worth loading up: non-ASCII subject and body, a `cid:` image pasted mid-body, a long URL that forces quoted-printable soft breaks, and attachments alongside the inline image, which together produce the deepest realistic tree (`multipart/mixed` → `multipart/related` → `multipart/alternative`). Every client capture then inherits those properties instead of re-testing plain text.
- **Keep one minimal capture alongside the rich ones.** A corpus drawn entirely from the loaded source message carries a `multipart/related` layer, an inline `cid:` image, and a non-ASCII subject in every specimen, so code that assumes any of the three is present passes the whole suite and then fails on the plainest letter anyone sends. `outlook-desktop-inline-plain.eml` forwards an earlier plain-text message — ASCII subject, `multipart/mixed` → `multipart/alternative`, attachments with no inline image — and covers that shape. One such fixture is enough, since client structure is already characterized by the rich captures.
- **Spend device captures on Outlook, not on Gmail.** Gmail web and Gmail Android emit the same MIME apart from a twelve-character compose wrapper, because Gmail's servers assemble the message and the app contributes only a body fragment. Outlook never converges: desktop, web, and Android disagree on subject charset (`utf-8` against `Windows-1252`), body transfer encoding (base64 against quoted-printable), quoted-printable wrap columns, and injected markup. Those differences survive the forward-as-attachment path, where the compose body is empty and desktop still emits a base64 `WordSection1` stylesheet that web omits — so relaying through a shared Exchange Online tenant does not normalize client output.
- **HEIC needs no email capture.** The transcoder takes bytes and a content type, so a bare `.heic` file on disk exercises it completely, and the MIME plumbing around an attachment is already covered by the JPEG fixtures. Spend captures on structure that only a real client produces.
- **Fixture content is synthetic; fixture structure is not.** The repo is public, so **no real missionary letter ever becomes a fixture**. Compose one placeholder letter and forward that same body from every client — the extractor reads boundaries, encodings, and header shapes and is indifferent to the words, so holding content constant makes every diff between fixtures purely structural. The captures themselves must come from real clients: a hand-written approximation of a Gmail iOS forward tests an assumption about the client rather than the client. Use accounts whose addresses can be public, because `From`, `To`, and `Received` lines are part of the specimen and editing them by hand corrupts the byte structure being preserved. Fixture DKIM signatures do not need to validate — DMARC is evaluated at Cloudflare before the Worker sees the message, and the ingest Function reads `Authentication-Results` as text. When a real message trips a bug, reduce it to a minimal synthetic reproduction and commit that.
- **Scrub captures with `tools/scrub-fixtures.ps1`, not with find/replace.** Identifying strings do not sit in the file as plain text: Outlook desktop base64-encodes the whole forwarded block, Outlook web splits addresses across quoted-printable soft breaks (`elder=` / newline / `.example@missionary.org`), subjects arrive as RFC 2047 encoded words, and charsets vary per client. An editor-level replace misses all four and leaves the file looking clean. Outlook Android goes further and base64-encodes an entire embedded message as `application/octet-stream`, so its parts appear nowhere in the file and the scrubber recurses into the decoded payload rather than treating it as one opaque blob. The script decodes each part, replaces, and re-encodes in the part's own charset and transfer encoding; `-Check` re-decodes to verify. Verify a scrub by decoding the parts afterwards — attachment byte counts and the `Content-Type` / `Content-Transfer-Encoding` inventory should be identical to the capture.
- **Scrub maps need bare local-parts, not just whole addresses.** SRS rewriting at the forwarding hop re-forms the envelope sender as `origdomain=localpart@forwarder` — `elder.example@missionary.org` becomes `SRS0=hf4-=3f=missionary.org=elder.example@pdayletters.com` in `Return-Path`, `Received-SPF`, and the SPF clauses of every downstream `Authentication-Results`. The whole address never appears literally, so a map keyed on it leaves the identity in place while every check reports clean.
- **Every real identity gets its own placeholder.** Mapping two people onto one string produces a fixture that asserts something false — a capture where `From:` and `Delivered-To:` collapse to the same address claims the missionary delivered mail to himself, and any test asserting sender ≠ recipient fails against a file that is simply wrong. Scrubbing preserves structure; structure includes which addresses are distinct from which.
- **A placeholder domain has to agree with the authentication verdict.** `Authentication-Results` is not scrubbable: it is the receiving edge's testimony about the domain that actually sent the message, and rewriting it destroys the one piece of evidence the classifier reads. Scrubbing a Gmail forwarder to `family.example@example.com` therefore yields a capture whose `From:` says `example.com` while the verdict says `dmarc=pass header.from=gmail.com` — misaligned, rejected by any correct classifier, and worthless as a test. When the sending domain is generic enough to carry no identity, keep it and replace only the local-part: `gmail.com` names a provider, not a person. Save the RFC 2606 reserved domains for personas that never appear in an authentication result, such as the capture mailbox.
- **Unscrubbed originals live in the private companion repo**, `mission-journal-private`, because scrubbing invalidates DKIM — the signature covers `From:` and a body hash. Structure and header-shape tests run against the public scrubbed corpus; DKIM re-verification needs an intact specimen and reads from the private path, skipping when it is absent so a fresh public clone still passes.
- **Email Worker**: streams `message.raw` to `inbox/{ulid}.raw`, enqueues the ULID, and does nothing else. On any failure it **throws rather than swallowing**, so Cloudflare returns a temporary SMTP error and the sending server keeps the only copy and retries. Deploy with Wrangler; keep it in this repo alongside the Functions so the two ship together.
- **Worker telemetry goes to Workers Logs, not App Insights.** That is the real cost of a second runtime: the first component to touch every message reports somewhere else. Accept it for Stage 1, but treat a Worker-side error rate as something you must remember to look at — nothing in Azure will tell you.
- **Exercise a bulk backfill deliberately**, not just single letters. Forward twenty or more messages in one sitting and confirm the queue drains, `posts.json` survives the concurrent appends via its ETag guard, and nothing is dropped. This is the shape of the very first real use, and it is the scenario the provider choice was made to protect.
- Queue-triggered ingest Function:
  - Classifier per the [message classification](#message-classification) table, with only the `forward` branch live. DKIM re-verification against `missionary.org`'s public key for the embedded `.eml`.
  - **Report the DKIM re-verification result explicitly**, pass or fail, rather than folding a failure into the silent-rejection path. Re-verifying a real forward of recent missionary mail is the first honest test of whether that check is viable at all — DKIM keys rotate, and the plan leans on re-verification for a use case that explicitly includes letters forwarded years later.
  - Slug resolution via [sender-based routing](#sender-based-routing); forwarder-vs-ACL check against the hand-written `acl.json`; inline forwards accepted only from owners.
  - Original-message extractor over `postal-mime`: `message/rfc822` attachments first, then inline-forward fallback (Gmail / Apple Mail / Outlook separators). Size-cap the message before parsing.
  - Append a bare post record to `rendered/{slug}/posts.json` (subject, body, original headers — `photos: []` for now) and write raw MIME + attachments to `raw/{slug}/{msgId}/` with sanitized path segments. Log rejections to App Insights only (sender, subject, reason, timestamp — no body).
- **`posts.json` is ETag-guarded from the first write**, per [Concurrency](#extracting-and-de-duplicating-forwards) — `If-None-Match: *` on creation, `If-Match` on append, retry on `412`. This is separate from dedup and cannot wait for it: bulk-forwarding a stack of letters in one sitting is the very first thing that will happen, and unguarded concurrent appends lose posts silently.
- **Flag posts whose photos arrived as links.** A regex over the sanitized body for `photos.app.goo.gl`, `photos.google.com`, and `drive.google.com`, recorded on the post as which service was seen. Detection only — nothing is fetched, and see [Photos that arrive as links](#photos-that-arrive-as-links-not-attachments) for why fetching a Google Photos album is impossible rather than merely unbuilt. Both of the first two real letters carried such a link, and this counts how often it happens and to which service, which is the evidence any later decision needs. It doubles as the signal for an oversized send that was stripped of its attachments in transit.
- **No dedup.** One forwarder cannot duplicate their own letters, and the reset script is the cleanup path. Dedup arrives in [Phase 7](#phase-7--onboarding-pending-sites-and-the-claim-flow), where pending-site promotion is the first thing that genuinely cannot work without it.
- **Verification is Storage Explorer.** No `/manage/last-received` page — it would need an authorization model that doesn't exist until Phase 3, and inspecting blobs directly is adequate for two phases. The operator view arrives in Phase 9 with the role it belongs to.

### Phase 2 — Render pipeline
**Shipped.** 24 posts, 49 photos rendered.

- Queue-triggered render Function: parse raw `.eml` → **sanitize HTML** per [Content sanitization](#content-sanitization) (allowlist, `cid:` rewriting, remote-image stripping) → resize photos to WebP + strip EXIF → write photos to `rendered/{slug}/photos/{p_sha256[:12]}/*` and fill in the target post's `photos` array in `posts.json` (ETag-guarded, same as ingest).
- **HEIC decoding is a defensive branch, not the common path.** Mission-issued phones are Android, which does not emit HEIC by default: Pixel offers no such setting at all, and Samsung ships the option off. It still arrives occasionally — a family member on an iPhone attaching a photo to a forward — so decode it and fall back to dropping that photo rather than the post. Cover it with a synthetic `.heic` file.
- Guard against oversized messages: cap decoded attachment bytes **and decoded pixel dimensions** per message, and stream rather than buffer, so neither a 25 MB email nor a small file that decodes to a gigapixel image exhausts a Consumption instance. A decode failure drops that photo and publishes the post, rather than failing the ingest.
- Idempotent: rerunning against the same `raw/` yields the same rendered output, guaranteed by content-hash photo IDs. Post text is already in `posts.json` from Phase 1; render only fills in sanitized HTML and photo fields, so double-runs are safe.
- **Verification:** run the Phase 1 fixture corpus through and diff the rendered output. Confirm posts sort by `originalDate` and that photo arrays fill in shortly after ingest.

### Phase 3 — Auth and private content delivery
**Shipped**, including Google. Microsoft work and personal accounts both verified through the one button.

- SWA authentication enabled. **Microsoft alone is enough to unblock the loop**; add Google before any content is shown to someone who isn't you, since the eventual audience is Google-native.
- **Adding Google is what buys the Standard plan**, and it is not just a second button. Custom authentication is Standard-only, and **any custom registration disables every preconfigured provider** — so Microsoft has to be re-declared as a custom provider with our own Entra app registration at the same time. Budget for the tier change and the Entra app together.
- **The Entra registration needs `enableIdTokenIssuance`, and Bicep cannot say so.** SWA custom auth asks for `response_type=id_token`; `az ad app create` leaves that grant off, so Entra answers 700054 and returns the visitor to `/.auth/login/aad/callback` with no session. Set it with `az ad app update --id <appId> --enable-id-token-issuance true` and treat it as part of *creating* the registration — a rebuild from `main.bicep` will not restore it, because the property lives in Graph rather than ARM. It cost most of a day here, and the reason it did is worth recording: **Google worked throughout**, so the evidence pointed at the Microsoft configuration rather than at the registration, and five plausible-but-wrong causes got shipped before anyone looked at the grant. When one provider works and another doesn't, compare how the two are *registered* before theorising about how they're *configured*.
- **`openIdIssuer` is `common/v2.0`, deliberately.** That endpoint advertises its issuer as the template `https://login.microsoftonline.com/{tenantid}/v2.0`, which looks broken and is not — the validator substitutes the token's `tid`. Verified against a work account and a personal Microsoft account, both of which sign in through the one button. Pinning a tenant GUID instead would lock out every other organisation *and* all personal accounts, which is the opposite of what a family audience needs, and it fails quietly: authentication succeeds and the callback rejects the token.
- `/api/content/{slug}/posts.json` and `/api/photo/{slug}/{photoId}/{size}.webp` per [Private content delivery](#private-content-delivery): read `x-ms-client-principal`, check `config/{slug}/acl.json`, stream the blob, `Cache-Control: private, max-age=3600`.
- **One shared authorization function** returning a role for (identity, slug). Stage 1 has a single branch — look up `acl.json`. Operators (Phase 9) resolve above it and invitations (Phase 9) write into it; neither changes the callers.
- Response hardening on every byte-streaming endpoint: `Content-Type` pinned from our own transcode rather than from the attachment, `X-Content-Type-Options: nosniff`, and the strict `Content-Security-Policy` from [Content sanitization](#content-sanitization).
- SWA route rules gating `/{missionary-slug}/*`, plus the **`401` deep-link override** — cheap, and the difference between a bookmark that works and a bare error. The `/login` chooser, the `403` page, and the site switcher are Phase 9.

### Phase 4 — Reader UI and search
**Shipped.** See the [Reader UI backlog](#reader-ui-backlog) for what a first real read-through exposed — the phase is built, not finished.

- **Public landing page at `/`** — what the service is and the `post@pdayletters.com` address. Unauthenticated, entirely generic, no per-site information. `claim@` instructions arrive with the claim flow in Phase 7.
- **Subtle `beta` mark** beside the product name wherever it appears. Removed in Phase 12 and not before. See [The service is in beta](#the-service-is-in-beta-until-the-privacy-policy-ships).
- Path-routed `/{missionary-slug}` reader: list posts sorted by `originalDate`, post view, photo album, MiniSearch index built client-side from `posts.json`, with search text derived by stripping tags from `bodyHtml`.
- Content is served through `/api/content/…` and `/api/photo/…` from the start. There is deliberately no anonymous escape hatch — a temporary flag that exposes real family mail is precisely the kind of thing that survives to production.
- **Base the type scale, contrast, and touch targets on the actual audience.** Grandparents are the primary readers, and this is far cheaper to decide here than to retrofit.

### Phase 5 — Offline archive export
**Shipped**, and redesigned in the building — the zip is staged in blob storage and handed back as a SAS link rather than streamed through the Function.

- "Download my letters" Function bundles `index.html` + `posts.json` + `photos/` into a self-contained zip, built from the **same ACL-filtered payload the reader UI receives**, so there is never a second filtering rule to keep in sync. **`raw/` is never bundled** — see [Storage layout](#storage-layout).
- Packaged reader HTML reads local JSON and builds the search index in-browser — identical code path to the hosted reader, so search works with zero backend.
- **Measure the full-mission case early even though Stage 1 won't hit it.** The cost is not compression: the renditions are already entropy-coded, so photo entries are **stored rather than deflated** and only `index.html` and `posts.json` are worth compressing. The real constraint was never building the zip — those are bytes we already hold — but holding an HTTP response open for the length of the *client's* download, which a slow connection can stretch past the SWA response timeout with no way to resume.
- **That constraint is now designed out: the Function stages the zip in blob storage and hands back a link.** `download` builds the archive straight into `exports/{slug}/{role}.zip` and answers `302` with a 15-minute, read-only, single-blob **user-delegation SAS**. The Function is then on the hook only for the build, which is fast and in-region; the transfer moves to storage, which serves `Accept-Ranges: bytes` and so can be *resumed*. Measured on the real 24-letter site: 20 MB, 105 entries, built and uploaded in **4.2 s**, fetched back in **0.8 s** against ~7.6 s streaming it through the Function. The earlier 400–500 MB estimate assumed ~10 photos per letter; the real density is ~2, so a full 104-letter mission projects to roughly 80 MB — well inside the response window even before the transfer was moved off it.
  - **The staged copy is named for the role, and rebuilt every time.** An owner's archive contains held letters and a reader's does not, so one filename for both would eventually hand a reader the wrong zip. Caching was considered and rejected for the same reason: a cached archive would need invalidating on every edit, hide and unhide *and* keying by role, which is precisely the shape of mistake that leaks a held letter. Rebuilding costs seconds and removes the whole class of bug.
  - **The SAS carries no identity**, so it is minted only after the same gate the reader passes, and scoped to one blob, one verb, HTTPS only. It is signed by a user delegation key rather than an account key — the Function App's managed identity already holds `Storage Blob Data Owner`, which includes `generateUserDelegationKey`, so no new grant was needed. Verified: the same URL with its signature stripped is refused outright, because the account has `allowBlobPublicAccess: false`.
  - **A failure can now be an honest status code again.** The streaming version had already sent its `200` by the time a photo read failed, so a broken export arrived as a truncated file that looked fine until someone opened it. Nothing is sent until the upload completes, so the build and the upload are awaited together — with `allSettled` rather than `all`, since whichever fails second would otherwise surface as an unhandled rejection after the request was answered and take the worker down with it. All three paths were exercised deliberately: both succeed, upload fails mid-build, build throws mid-upload.
  - **Loose end, deliberately not built:** `exports/` accumulates. Each rebuild overwrites, so it is bounded at two blobs per slug, but versioning is on and every overwrite retains a 30-day version. At Stage 1 scale that is cents, and the container is private with no anonymous access, so this is a tidiness and cost question rather than a security one. A lifecycle rule deleting `exports/` blobs and versions after a day is the fix, and belongs with the Phase 9 retention work rather than here — it is derived data, every byte of which can be rebuilt from `rendered/`.
    - **Closed 2026-08-06, alongside site deletion.** `expire-exports` deletes blobs, snapshots and versions after **7 days** rather than one. The reasoning shifted while writing it: this is not only tidiness, because an export is a second copy of an entire family's correspondence sitting under a URL somebody was emailed. Seven days is the shortest window that still covers a link nobody opened until the weekend.

**Stage 1 is done when:** a real letter forwarded from a personal mailbox appears at `/{slug}` signed in as the ACL's one owner, with its photos, findable by searching a word from its body — and the downloaded zip does the same thing offline.

**Met**, against 24 real letters.

---

## Stage 2 — Widening

### Phase 6 — Direct ingest
**Partly shipped, and further along than it looked.** The classifier's `direct` branch is implemented and returns `publish`; the corpus carries three direct captures — `direct-missionary`, `direct-bcc-inline-via-cloudflare`, `direct-bcc-inline-via-exchange` — and a real `@missionary.org` send is on record passing DMARC at our edge. The `originalDate` ordering is fixed and covered, the warning-level logging of a missionary-domain rejection turned out to have been built all along, and an unclaimed direct send is now held as a pending site. **What is genuinely outstanding: one live end-to-end run.**

**Three separate items in this phase were recorded as missing and were already built.** Each was written down from memory of the plan rather than from the code, and each cost a round of work to discover. The corpus and the source are cheap to read; assume less.

**Gated on access to a real `@missionary.org` account**, which is what makes everything here testable rather than inferred. See [Building blind](#building-blind).

- **Send before building, not after.** The Worker streams every message to `inbox/{ulid}.raw` before anything inspects it, so a message arriving today can be replayed against the `direct` branch indefinitely — the classifier not yet knowing what to do with it costs nothing. Code can be written any day; the account cannot send on any day. Treat the send as a *capture* operation and get the raw blob out to the private repo the same day, ahead of the 30-day `inbox/` lifecycle rule.
- **Capture the `missionary.org` DKIM public key alongside the message.** The selector is in the message headers, and the key it names is a plain DNS lookup — but only while you know the selector, and only until it rotates. This plan leans on re-verifying signatures on letters forwarded *years* after they were sent, so the pass path becomes permanently untestable the moment that key rolls and no copy was kept. Store the record with the fixture.
- **Do not spend the window on the OAuth question.** Whether an `@missionary.org` Google account can sign in to a third-party app looked like a gate and is not one: [ownership binds a personal account by design](#the-60-day-cliff), so a `no` costs nothing and a `yes` is merely a case already handled defensively. The mechanism makes it close to moot anyway — missionaries reach that mailbox by signing in to the Church's own site and following a link through to Gmail, so they never hold a Google password to give a consent screen. Reported from direct experience rather than measured here, and it is not worth measuring: the claim flow was built not to need it.
- **Most of the deferred Phase 0 checklist was already answered by a fixture nobody re-read.** `direct-missionary.eml` in the private corpus is a genuine `@missionary.org` send that reached Cloudflare, and its `mx.cloudflare.net` verdict is `dmarc=pass header.from=missionary.org policy.dmarc=quarantine`, with `dkim=pass header.d=missionary.org header.s=google`. The question this phase was gated on — *does real missionary mail pass DMARC at our edge* — has a recorded yes, and had one before the account access was ever at risk. **Check the corpus before spending a scarce credential**: the evidence for a gating question is quite often already sitting in a file, and a fixture is worth re-reading for facts it was not originally captured to prove.
- **`missionary.org` is Proofpoint *and* Google Workspace, on different sides.** Proofpoint terminates inbound and owns SPF — a macro-expanded `include:%{ir}.%{v}.%{d}.spf.has.pphosted.com` that authorises per sending IP at lookup time — and both DMARC report addresses. Google Workspace hosts the mailboxes and signs outbound with selector `google`. This matters twice over: the Proofpoint URL Defense premise behind [POST-not-GET on signed links](#phase-7--onboarding-pending-sites-and-the-claim-flow) is correct and stays, and an `@missionary.org` mailbox genuinely is a Google account, which is what the OAuth question above turns on. The domain also publishes **`p=quarantine`**, not `p=none`; forwarding survives it only because Cloudflare SRS-rewrites the envelope sender.
- **A direct send lands on `localPartOf(From:)`, and that path consults no ACL — so it could name a site that does not exist.** It did not fail: it published to a brand-new slug with no `acl.json` and no `profile.json`, producing a letter rendered and stored where nobody could read it and nothing would clean it up, with no report to anyone. **Fixed by pulling the accumulation half of [pending sites](#phase-7--onboarding-pending-sites-and-the-claim-flow) forward from Phase 7.** The message is written to `pending/{slug}/`, a `claim.json` records the rolling sixty-day window and the message count under an ETag, and nothing is rendered, published or queued. The claim email and the `/claim/{token}` page stay in Phase 7 — but accumulation is the half that had to come first, because it is the half that *loses letters* when it is missing. A claim flow can be built next month against letters already safely held; it cannot recover letters dropped while it was being written.
  - **A forward to an unknown slug still rejects**, and that stays. `classify` refuses it earlier, because a forwarder must already be on an ACL to be trusted — accepting forwards into a pending site is what needs the claim email to exist, since silently accumulating a stranger's mail with no way to tell anyone is worse than a clean rejection.

- **`direct` classification goes live.** Log the full `Authentication-Results` header verbatim for any message whose `From:` domain is in `MISSIONARY_DOMAINS`, and raise a *warning* rather than a silent rejection when such a message fails to classify.
- **Run the deferred Phase 0 checklist**, which this phase exists to unblock: confirm a genuine DMARC pass on Proofpoint-relayed missionary mail, confirm a threaded reply reaches the inbox rather than spam, and test whether an `@missionary.org` Google account can sign in to a third-party OAuth app.
- **Still no dedup.** While one person drives both sides of the test, sending the same letter twice is a choice rather than an accident. It becomes unavoidable in Phase 7, where a pending site accumulates from several relatives at once.
- **Fixed — and the fix prescribed here was the wrong one.** `presentPosts` compared `originalDate` as a string, which was correct only by accident: the offset happens to sort after a fixed-width stamp, so the result was wall-clock order arrived at by luck, and a stamp that ever lost its seconds would have silently reordered an archive. The instruction was to *compare parsed instants*. **Measured, that is worse.** A missionary transferred from `+08:00` to `-07:00` writes a letter headed August 2 whose instant *precedes* one headed August 1, so instant ordering lists August 2 above August 1 while the page prints those dates beside them — the position contradicts the label. Worse, an inline forward carries no offset at all, so it has no instant to compare without inventing a zone, and `Date.parse` invents the *host's* — making the order of a family's letters depend on where the code happens to run. The comparison is now an explicit byte comparison of the first 19 characters, ties broken on `id` so the order is total and identical between requests, with four tests over the transfer case, the mixed offset-free case, the tie, and an undated post. This also agrees with the reader, which splits the date rather than parsing it so a relative in another zone sees the day the missionary wrote. **The general lesson: "compare instants" is the reflex answer for timestamps, and it is wrong wherever the local calendar day is the thing being displayed.**
- **Verification:** send a `direct` message and confirm it publishes to the same slug that a forward of the same letter reaches.

### Phase 7 — Onboarding: pending sites and the claim flow
**Mostly shipped.** Accumulation landed early in Phase 6; the claim half landed after it. Tokens are HMAC-signed with a key from Key Vault and only their hashes are stored; `/claim` describes a pending site to an anonymous visitor and redeems it for a signed-in one; redemption spends the token before it grants anything, creates `acl.json` with `If-None-Match: *`, writes a membership row, and promotes the whole backlog through the same code path that commits a live letter. 219 tests, up from 168.

**What remains:** the claim email is drafted but nothing sends it, which blocks the reminder and the tapering invitation series and makes `claimEmailSentAt` a field nothing writes in anger. The `claim@` handler, the "a site already exists" reply, and the "email me a new link" path are all untouched. Every one of them is waiting on [Phase 8](#phase-8--outbound-mail-and-preferences), not on this phase.

**The expiry purge has shipped** as a nightly timer. It is the only code in the system that destroys a letter, so its bias runs opposite to everything else here: every ambiguity resolves to *keep*. An unreadable manifest, an unparseable expiry, or a claimed site that still holds letters are all kept and logged rather than swept, because the cost of keeping too long is storage and the cost of deleting too early is unrecoverable. It also deletes the letters **before** the manifest, so a crash partway leaves a still-expired manifest the next run finishes off, rather than `.eml` files nothing will ever list again. **It waits seven days past `expiresAt` before acting** — not caution for its own sake, but because `describeClaim` deliberately returns the slug for an *expired* token so the page can offer a fresh link, and purging at the instant of expiry would make that offer unkeepable. A site that expires having never been emailed is logged at error level and separately from the routine count: that site was not ignored, it was never *offered*, which is our bug rather than a family's silence.

Until this ships, sites are hand-provisioned. This is what makes the service self-serve.

- ~~Create the `pending/` container and the `users` table. Add the HMAC token-signing service (key from Key Vault).~~ **Done.** Both tables exist and are declared in Bicep. The signing key is created out of band by `infra/provision-claim.ps1` rather than by Bicep, because a Bicep-declared secret takes its value as a parameter and parameters are retained in the deployment history in plain text. **The key is never regenerated on a re-run**, since rotating it invalidates every claim link already sitting in somebody's inbox.
- **Move ingest to Workers Paid** if it hasn't happened already. Self-serve onboarding is the point at which inbound volume stops being predictable, and Workers Free's CPU and memory limits on email handlers are not something to discover under load — a handler that exceeds them fails the message and logs `EXCEEDED_CPU`. **It is also a hard prerequisite for the claim email itself**, since outbound sending to arbitrary recipients is unavailable on the free plan at any volume. See [Phase 8](#phase-8--outbound-mail-and-preferences).
- ~~**De-duplication**, which promotion cannot work without.~~ **Already built, and found by reading rather than by writing.** `findDuplicate` takes a candidate and a list, so promotion gets batch behaviour for free by committing letters one at a time against an accumulating `posts.json` — the same loop, the same ETag, the same gate. **The batch dedup that this bullet called for did not need to be written at all.** That is now four separate items in this plan recorded as missing and found already built; the pattern each time was asserting from memory of the plan instead of opening the file.
- **Arrival order needs no tie-breaking.** A letter must be sent before it can be forwarded, so the `direct` copy normally arrives first and first-write-wins is correct by default. Promotion replays in ULID order, which is arrival order, so the same rule holds for a backlog.
- **Promotion must never re-classify.** It reuses the *commit* half of ingest and takes the verdict as an argument rather than recomputing one. Re-classifying would mean re-verifying DKIM against whatever key the sending domain publishes *now*, possibly months later — and domains rotate keys. A letter that verified on arrival can fail verification later through nobody's fault, and the cost of that would be discarding the letter the whole mechanism exists to preserve. Splitting `commitLetter` out of `runIngest` was what made this possible; it is behaviour-preserving and the existing suite proved it.
- **Pending sites and claim** per [Onboarding and auto-provisioning](#onboarding-and-auto-provisioning). Shipped: the anonymous landing page showing sender, waiting count and sample subjects before sign-in; the first owner; the display name; promotion of accumulated raw; the failure page; the rolling `expiresAt` and the timer-triggered purge. **The sample subjects and the count are recorded on `claim.json` as letters arrive**, rather than computed by opening every held message on a page load — a claim page that has to parse a year of mail before it renders is a claim page that times out for exactly the families with the most to lose. Capped at three, because a stolen link should not hand over a summary of the whole archive. Still missing: the reminder, the tapering series, and "email me a new link", all of which are sends.

  **The address the claim link is sent to must come from the envelope, never the body — fixed once the send path made it reachable.** `holdPending` was recording `extracted.original.from` as the pending site's sender. On a *forward* that is right and is the entire point of the extractor. On a *direct* send there is no forward to see past, and the extractor's fallback still fires: a body line beginning `From:` is exactly what a mail client leaves behind when it flattens a forward, so a missionary quoting a message from home had the quoted address recorded as his own. `classify` was never fooled — the direct branch keys off the authenticated envelope sender and already computes it as `verdict.author` — but the pending manifest took the extraction, and the claim link is emailed to whatever the manifest says. **The result was a credential for the site routed by attacker-supplied text**, in a design whose central claim is that there is no attacker-supplied "which site" value. The exploit is weak (you must first authenticate as `@missionary.org`, so you are attacking your own site) and the mistake is not (a quoted email sends your claim link to your mother). Fixed to use `verdict.author`; the regression test asserts the quoted address is ignored, and was confirmed to fail before the change rather than assumed to.

  **It was invisible for as long as it was harmless.** The field had been recorded and never read since Phase 7; wiring the send in Phase 8 turned a dormant metadata error into a delivery decision, and the [allowlist](#phase-8--outbound-mail-and-preferences) then hid it again by refusing to send anywhere unlisted. Both defences were doing their jobs and both would have stopped working on the day the allowlist opened. **The general shape is worth keeping: a value nothing consumes is not verified by anything, so the commit that first consumes it is where its history gets audited** — not the commit that introduced it.
- ~~**Signed links perform state changes on `POST`, never on `GET`.**~~ **Done, and then done better.** The `POST` rule stands, but the token no longer travels in a URL at all: the emailed link is `/claim#<token>`, and a fragment is never transmitted to a server. That closes two holes at once — Proofpoint URL Defense cannot spend a token it cannot see, and App Insights cannot log one it never receives. **A token in a route would have been copied into telemetry retained for months**, which the original design would have shipped. The page moves it into `sessionStorage` immediately, because claiming requires signing in and the fragment would not survive that round trip.
- ~~**Claim redemption is atomic.**~~ **Done**, in the order this bullet prescribed: spend under an ETag on `claim.json`, then create `acl.json` with `If-None-Match: *`. Both steps are idempotent *for the same principal* and absolute for a different one, so a claimant whose request died halfway can follow the link again and resume, while a second person following the same link is refused. The ACL, not the claim record, is the authority on which of those happened.
- ~~**`claim@` handler**~~ per [Ownership and the 60-day window](#ownership-and-the-60-day-window): accept only DMARC-passing senders in `MISSIONARY_DOMAINS`, ignore everything else without reply, mail back a signed claim link that adds a `verifiedMissionary` owner. Reply copy must tell them to sign in with a **personal** Google/Microsoft account and explain the 60-day expiry. **Shipped.** The rule below held: `isClaimVerb` sits above `extractOriginal` in `runIngest`, and the claim path reads the header block with a purpose-built reader rather than the MIME parser. The pending flow still sets `verifiedMissionary: false` and is still the only sensible thing for it to do — following a link out of a forwarded email proves you were sent the link, not that you are the missionary.

  **Open to write to, and almost entirely closed to read from.** Delivery cannot be restricted — the domain takes a catch-all, so anyone on the internet can put a message in front of this handler, and a bounce or rejection at the edge is not available. What *is* available is refusing to look at it. The handler decides from the authenticated sender domain alone and discards before parsing: no body, no attachments, **no `extractOriginal`**. That code is the largest and most attacker-facing surface in the service — a MIME parser, a quoted-header scraper and a CP1252 repair pass, all running on bytes a stranger chose — and on this path it buys nothing, because `claim@` has no embedded original to recover. The claimant *is* the author; there is no forwarder to see past.

  This is the exact inverse of `post@`, and the contrast is the reason to write it down. There, extraction has to run before classification, because a forward's slug lives inside the attachment — the parser is unavoidably exposed and the design pays for that with DKIM re-verification. Here the same exposure would be gratuitous. **The rule to hold on to is that the two addresses must not share an ingest prologue**; the natural refactor, "parse once, then branch on the verb", would silently hand `claim@` the whole of `post@`'s attack surface while looking like tidying up.

  - ~~**⚠️ Today the verb is not read at all.**~~ **Closed, and it had stopped being theoretical.** `ingest` checked the recipient *domain* and never the local-part, which was harmless only for as long as nothing routed `claim@` to the Worker. Once a routing rule did, a missionary emailing `claim@` to ask for control of their site had that message classified `direct` and **published to their own archive** — the exact outcome the two-address split exists to prevent. The regression test asserts on storage rather than on a return value, because the bug's signature was a pending site appearing, not an error being raised.
  - **The grant is a second record, not a flag on the first.** `config/{slug}/missionary-claim.json` rather than a field on `pending/{slug}/claim.json`, for three reasons that each independently rule the flag out: a pending record is purged with the letters it belongs to, and a missionary may be claiming a site that has been live for months; a pending record is spent permanently on first claim, while this grant's whole purpose is to work on a site somebody else already claimed; and one blob with two meanings would put the decision about whether `verifiedMissionary` is set inside a field that a stranger's claim flow also writes. **Neither kind is distinguishable from its token** — both are `issueClaimToken({slug, key, expiresAt})` — because putting the kind in the payload would mean a signed assertion about its own privilege level travelling through a mailbox. The stored hash decides, which keeps the answer server-side.
  - **Redemption is additive, and re-issuable.** The pending path refuses a second claimant because the first became the sole owner and a second would be an eviction. This path adds an owner to whatever ACL exists — upgrading an entry in place if the missionary was already a reader, and keeping their original `addedAt` — so a retry, or a second personal account, costs nothing and refusing would strand somebody who closed the tab. **Claiming never demotes anyone.**
  - **The claim page needed copy of its own.** The pending panel says "*N* letters from X have arrived and are being held" and "setting up the archive makes you its owner". On a site a parent has been running for months, every clause of that is false, and the count renders as `0 letters`. `describeClaim` now returns a `kind` and the page branches on it.
- The "a site already exists" reply for DKIM-verified non-ACL senders, including `claim@` instructions.

### Phase 8 — Outbound mail and preferences
**The send layer and the claim email are shipped; the preferences half is not started.** The provider is **Cloudflare Email Service** — what was Email Routing has become a full sending product, with a `send_email` Workers binding, a REST API, SMTP, a suppression list, and Google Postmaster feedback. Every header this phase needs is allowlisted, so nothing here has to move elsewhere.

**Sending goes through the REST API from the Function, not the Workers binding, and that reverses what this plan used to assume.** Phase 7 asked for the claim email to be sent "as a reply to an arriving letter", which reads as a requirement for `message.reply()` — the only thing that literally is one. It is not. Cloudflare's own reply example sets `In-Reply-To` and `References` by hand, so **threading is a property of headers we write, not of the transport**, and a REST send reproduces it exactly. What `reply()` uniquely adds is a list of ways to fail — the incoming message must pass DMARC, one reply per event, the recipient must equal the incoming sender, the domains must match, `References` must be under 100 entries — every one of which lands at the exact moment somebody's first letter arrives. It would also have contradicted the Worker's own stated principle, which is that anything deferrable to ingest is deferred, because a failure there retries from durable storage and a failure in the Worker costs the only copy of the message. The plan described a mechanism when it meant an outcome.

- **Nothing sends unless `MAIL_ALLOWLIST` names the recipient, and empty means nobody.** This defaults closed while the [purge timer](#phase-7--onboarding-pending-sites-and-the-claim-flow) defaults open, and the asymmetry is the point: there, forgetting a flag can only cause deletion to happen, and the dangerous outcome is silence; here, every recipient is computed from headers a stranger wrote, and the dangerous outcome is mailing that stranger. A send that reaches nobody shows up in the logs and costs a setting to fix. `*` opens it, and has to be typed on purpose.
  - **It is now `*` in production**, typed on purpose. Two named test addresses were enough while the only outbound message was a claim email to a mailbox we controlled; they are not enough for `claim@`, whose whole point is answering a missionary we have never corresponded with, and they would have failed as a *blocked* send with a reason nobody was watching for. **The mechanism stays** — the code still defaults to nobody, so a fresh environment is silent until somebody widens it, and the value is one setting to narrow again if the classifier ever starts picking recipients badly.
- **Nothing in the send path logs a body, a subject, or a full address.** The claim email's entire security model is that its token is seen only by whoever received it, and the token is in the body. Recipients are masked to `s***@domain` — enough to tell two failures apart, not enough to be an address. The `fetch` failure path deliberately drops the error message, because a fetch error can quote the request, and the request carries the API token in a header and the claim token in the body.
- **Minting a claim token and recording that one was sent are now two separate writes**, and that split fixed a live bug rather than tidying anything. They used to be one, so `claimEmailCount` incremented whenever minting succeeded — whether or not anything sent. The purge timer reads exactly that field to decide whether it is deleting letters from somebody who was never told. A broken send would therefore have produced a manifest asserting the offer had been made, and the letters would have been destroyed on schedule, silently, by the one job written to shout about that exact case.
- **A pending site is offered once, on the letter that created it.** Later letters do not re-offer, because minting invalidates the previous token: somebody writing weekly would be handed a fresh credential every week and find the link they had finally got round to clicking had just stopped working. Chasing an unclaimed site is the reminder series' job, on its own schedule. The condition is `claimEmailCount === 0` rather than a flag, which makes a failed send self-healing — nothing was recorded, so the next letter tries again.
- **The claim email threads against the newest held letter, not the first.** `lastMessageId` is kept on the manifest for this. The newest is the one still open in the recipient's own thread; the first is one they would have to go looking for. Absent when the sending client wrote no `Message-ID`, which threads nothing and breaks nothing.
- **A permanent bounce is a failure, not a success.** The API call succeeds and delivers nothing, and treating that as sent is precisely how an owner stops hearing from a service whose only job is telling them things.

Two prerequisites stood between the service and being able to send anything, and both are now met:

- **`pdayletters.com` is onboarded for *sending* as of 2026-08-04.** `cf-bounce` now carries the bounce MX, an SPF record and a DKIM key on its own selector, all separate from the routing records on the root, which were untouched. Until this existed, mail could only go to the account's own verified destination addresses — fine for testing, useless for a claim email, which by definition goes to a stranger. **The onboarding screen proposed replacing `_dmarc` with a bare `v=DMARC1; p=reject;` and then did not do it**: the existing `p=none` record and its `rua=` survived, and stayed editable. Worth knowing, because the confirmation screen says conflicting records can be removed in place and reads as though it will.
- **Workers Paid is now required twice over.** Sending to arbitrary recipients is not available at all on the free plan, which makes it a hard gate on this phase rather than the soft CPU-headroom argument in Phase 7. 3,000 outbound emails are included per month and overage is $0.35 per thousand; sends to verified destinations are free on every plan and never count against the quota, so the family pilot costs nothing.
- **Email preview is on by default for a new sending domain and was turned off on 2026-08-04, before any send path existed.** It retains full message content for about seven days in the activity log, and a claim email's entire security model is that its token is seen only by the person who received it. Re-checked 2026-08-05 and still off; worth re-checking after any Email Service settings change, because it is the one setting that silently converts a credential into a logged one.

**Still to build:**

- Ack emails: post-published ack and dedupe ack, honoring `postAckEmails` / `dedupeAckEmails` on the recipient's `users` row, with `Auto-Submitted: auto-replied` and the loop guards. Both suppressed on the pending-promotion path. Replies to inbound mail set `From:` to the address written to and carry `In-Reply-To`/`References` threading headers.
- **Suppression has to be visible to owners, not just to us.** An address that hard-bounces or reports us as spam is suppressed account-wide, and every later send to it fails with `E_RECIPIENT_SUPPRESSED`. For a service whose entire job is telling people a letter arrived, that is silent failure at the worst possible place: the owner simply stops hearing from us, with nothing to notice and nothing to act on. Surface suppression in the admin view and treat a suppressed owner as a condition worth reporting, the same way a rejected ACL member is told why. **Unverified: the REST API's documented error table has no suppression code** — it is a Workers-binding string error, so how suppression surfaces over REST has to be observed rather than assumed.
- **`Message-ID` cannot be set** — it is platform-controlled and generated on a Cloudflare domain. Threading still works, because `In-Reply-To` and `References` are ours to write, but nothing downstream may assume it can recognise its own outbound `Message-ID` later.
- **Outbound sends appear as "dropped" in the Email Routing summary even when they were delivered.** Read [Email sending metrics](https://developers.cloudflare.com/email-service/observability/) instead. Recorded here because the dashboard actively lies about this and the obvious reading of it is that the feature is broken.
- **The Email Sending settings page reports a DMARC policy the domain does not have.** Its DNS list shows `_dmarc` as `v=DMARC1; p=reject;` while the published record is `v=DMARC1; p=none; rua=...`, confirmed against two independent resolvers. The `Unlocked` status beside it is the true part — Email Service is not managing that record, which is why the original survived onboarding — but the value column for an unlocked row shows what Cloudflare *would* write, not what exists. **Check DMARC policy in DNS, never on that page**, or someone will one day read `p=reject`, believe the domain is enforcing, and be wrong about it in the direction that matters.
- **An ACL member whose message is rejected always gets told why.** Silence is correct for strangers and wrong for someone who can already read the site — a reader who forwarded inline, or anyone whose DKIM re-verification failed, otherwise concludes it worked and loses the letter.
- Per-user settings page at **`/settings`**, not `/{slug}/settings` — these are columns on one `users` row, and a per-site URL implies a per-site scope that doesn't exist.
- One-click opt-out links that flip flags without sign-in, `POST`-confirmed per the scanner problem in Phase 7.
- ~~Per-slug daily ingest cap with alerting, so a mail loop or a forwarding rule gone wrong can't quietly generate thousands of posts and a matching storage bill.~~ **Shipped 2026-08-06 at 200 letters per archive per UTC day.** Points worth keeping:
  - **The number is set by the honest extreme, not the abusive one.** A two-year mission is about a hundred weekly letters, and forwarding the whole lot in one sitting is a scenario the pipeline was explicitly built to survive — it is what a family does on the day they find out this exists. 200 clears that with room to spare and still stops a loop two orders of magnitude short of "thousands".
  - **It counts rows in an `arrivals` table, one per letter, rather than incrementing a number.** Read-add-write loses increments whenever two messages are in flight, and the queue host runs a batch at a time — so under exactly the sustained flood this exists to catch, the counter would advance more slowly than the mail arrived and the cap would fire late or not at all. A row per message cannot undercount. It can *overshoot* by as many messages as are in flight when the line is crossed, which is the harmless direction; closing that needs an atomic counter the table wrapper does not expose.
  - **The check sits in `runIngest`, above both the pending branch and the commit.** A loop into an unclaimed site costs the same and is worse, because there is no owner to notice. **Promotion is exempt for free**, because it calls `commitLetter` directly — a claimed site replaying a year of held letters must never be capped, and those letters were already counted on the days they arrived.
  - **A refused letter is not a destroyed one.** The raw message stays in `inbox/` under its 30-day lifecycle rule, so a cap that fires wrongly is undone by re-enqueuing the ULID. That is what makes a hard refusal defensible here when almost nothing else in this pipeline may drop a letter.
  - **It fails open.** A table refusing reads is not evidence of a loop, and this is the one guard whose malfunction would otherwise reject real mail. The bias everywhere else is that a letter published in error is visible and reversible while a letter discarded is gone; a cost guard is not reason enough to invert it.
  - **Alerting is a log line and nothing more so far.** `ingest: daily cap reached` is logged at error level with the slug and count, which is what an alert rule would watch — but **no alert rule exists**, so today it is only visible to somebody already looking. `arrivals` rows also have no sweep; at real volume that is a few rows a week, but nothing deletes them.
- **Sending limits start low and rise with reputation**, so the first month is the tightest. Total outbound message size is 5 MiB against 25 MiB inbound, which matters if an ack ever quotes a letter back.
- ~~**Outbound mail must carry a display name.**~~ **Shipped 2026-08-05 and confirmed rendering in a real mail client.** `from` takes an ordinary RFC 5322 phrase — `P-Day Letters <address>` — passed straight through to Cloudflare's REST body; there is no `{ email, name }` form and none is needed. The name lives in a `mailFrom()` helper rather than in the address constants, because those constants are also *identity* and something may one day compare an incoming recipient against them. Every send site now uses it, and the tests pin the literal string a mail client parses rather than restating the implementation, which would let a broken one pass.
- **Decide the sending identity, and stop sending from `post@`.** Mail *to* `post@` becomes a post — that is the whole contract of the address. Sending *from* it inverts that contract at the one moment a person is most likely to hit reply: a missionary who answers the claim email with "what is this?" has their reply delivered to `post@`, classified as a direct send from a missionary domain, and published to their own archive, with our email quoted underneath it. The address is also not a correspondent. It has a couple of onboarding handlers and is otherwise a pipe, so presenting it as the thing that just wrote to you invites a conversation nothing is listening for. **`no-reply@` is the wrong correction** — it trades one silent failure for another, and [open question 1](#open-questions-to-confirm) is already that there is no way to reach a human. The shape to aim for is a separate identity for outbound system mail, something like `P-Day Letters <hello@pdayletters.com>`, with `post@` reserved for ingest and a real handler behind whatever address replies land at. **This does not affect threading**: `In-Reply-To` and `References` thread on `Message-ID`, not on the sender, so the claim email keeps sitting inside the missionary's own conversation whichever address it comes from. It does mean the ack emails' rule — reply from the address that was written to — has to be stated as applying to acks only, since those genuinely are answers to mail sent to `post@`.
  - **`hello@pdayletters.com` exists and routes to a human**, and **invitations already send from it**. Cloudflare authorises outbound sending per *domain*, not per address, so no dashboard configuration was needed for a second sender — worth knowing before anyone goes looking for a setting that is not there.
  - **`post@` and `claim@` are still the senders for the mail they answer**, and that is the rule rather than an omission. A claim email must come from `claim@` for deliverability: it threads into correspondence the missionary started, and moving the sender mid-conversation is what makes a reply land somewhere nobody is reading.

### Phase 9 — Owner admin, invitations, and operators
**Partly shipped, out of order.** Edit, hide and delete, the `/login` chooser, the `401` deep link, the signed-in state on the root page, the `memberships` index, the root archive list, **invitations and member management**, **profile editing**, **the in-site switcher and `403` handling**, **the operator role**, and now **site deletion** were all pulled forward — each because something already built was resting on it. **Everything else is untouched:** no restore-original, no `/manage/last-received`.

- ~~**`memberships` table** maintained alongside `acl.json`, plus a rebuild-from-`config/*` utility for drift recovery.~~ **Pulled forward into Phase 7, because the claim flow ended by making somebody the owner of a site they could not navigate to.** The root redirect is what a newly-claimed owner needs, and it is the one question `acl.json` cannot answer without scanning every ACL in the account. Deferring it would also have cost a backfill: the claim flow already writes `acl.json`, so writing the membership row in the same operation is nearly free, while adding it later means migrating sites that already exist. The rebuild utility shipped with it. **`acl.json` remains the authority** — a row grants nothing, and a stale one costs a redirect into a refusal rather than a stranger's letters.
- **Site switcher** and **signed-in root redirect**, with the no-memberships explanation for an address that isn't on any ACL. See [Switching between sites](#switching-between-sites).
  - ~~**`lastPostAt` is declared but nothing keeps it current.**~~ **Fixed by moving it off the membership rows entirely.** Both `lastPostAt` and the site's display name were being copied onto every member's row, which meant keeping either current required finding every member of a slug and writing to each — a cross-partition operation, on the ingest path, per post. So in practice neither was ever updated: the name froze at whatever the claimant first typed, and the sort silently became "most recently *added*". They now live on one row per site in a `sites` table, partitioned by slug. **Ingest writes a single entity per post in the slug's own partition**, and the read side pays a point read per archive the signed-in person actually belongs to — one or two for a family. Renaming a site is now one write that every reader sees, rather than a fan-out that was never built.
  - **It is a separate table rather than a reserved partition inside `memberships`, and that was not tidiness.** `rebuildMemberships` prunes by scanning for rows whose `rowKey` is the slug and whose partition is not on the ACL. A site row keyed that way matches that description exactly, so the repair path would have deleted it — silently, and only on the drift-recovery path that exists precisely because something has already gone wrong.
  - **The site writes are guarded; the letter is not.** A table failure during ingest is logged and swallowed, because this is a sort key and the alternative is making the sender's mail server retry and deliver the letter twice. The same guard was added to the display-name write during a claim, after a test showed a failure there could fail the whole claim *after* the ACL had already been created — handing somebody an error for a site they had in fact just been given.
  - **The root half shipped, and it lists rather than redirects.** A signed-in visitor is offered their archives by name instead of being bounced to the most recent one. Redirecting would have been fewer clicks and worse: someone signed in with the wrong account — the work address rather than the personal one — needs to be able to *see* that, and a page that jumps straight through gives them no opportunity to notice. The no-memberships case is stated plainly for the same reason, since a signed-in person staring at a page that looks like it should have their letters on it will conclude they have lost them. ~~The in-site switcher is still to come.~~ **The switcher shipped 2026-08-06.** A `details` disclosure in the site masthead, populated from `/api/memberships`, listing every archive except the one on screen; nothing at all is drawn for the overwhelming majority who have one. It is fetched without being awaited — the letters are the point, and a masthead convenience must not put a second round trip in front of them — and it fails silently, because its absence needs no explaining. **It also renders on the refusal page, with nothing excluded**, which the design did not call for: somebody who has just been told no is exactly the person who has lost a URL, and the slug in their address bar is by definition not one of theirs.
- **Session handling** completed per [Sessions expire](#sessions-expire-and-re-authenticating-must-be-invisible): the `/login` chooser page, and a **Sign in** button on the public root. Verify that SWA's `.referrer` substitution survives the hop through `/login`.
  - **Mostly pulled forward.** The chooser, the root button and the `401` deep-link path all shipped with Google auth, and `.referrer` was measured rather than assumed — it does not survive, so the 401 override rewrites instead of redirecting. The root page now also recognises a signed-in visitor and offers their address and **Sign out** in place of **Sign in**, because a landing page that tells someone already signed in to sign in is a small lie told to the most nervous reader on the site. **The archive list has since shipped too**, so the page no longer stops at saying who you are.
- ~~**`403` handling** per [Signed in, but not on the list](#signed-in-but-not-on-the-list): a page naming the rejected identity with a sign-out-and-switch-account action, distinct from the Phase 3 `401` path.~~ **Shipped, and it is a panel on the archive page rather than a page of its own** — the refusal has to be told apart from an expired session at the moment the API answers, and a redirect would lose the URL that is the whole point of naming the account. It names the signed-in address when `/.auth/me` will say, stays silent about it when that call fails, and offers **Sign out and try another account** pointed back at the same path so the missing session becomes the ordinary `401` redirect. **The API still refuses to distinguish "no such archive" from "not yours"**, so neither does the wording.
  - **A defect found while doing this and worth remembering:** every owner-only page — `/people`, `/settings` — and both token pages sent an expired session straight to `/.auth/login/aad`. That was written when Microsoft was the only provider and was never revisited when Google was added, so a Google owner whose session lapsed was delivered to a Microsoft account the archive has never heard of, and then told, correctly and uselessly, that they are not the owner. All five now go through the `/login.html` chooser, which is the mechanism `app.js` had used all along.
- Owner admin view per [Editing and hiding posts](#editing-and-hiding-posts): edit any post's subject or body with edited HTML passing through the ingest sanitizer, ETag-guarded, dedup-derived fields read-only. Each edit stamps `editedBy` / `editedAt`, surfaced in the admin view and **stripped from the reader payload**. **Hidden posts are stripped server-side** in `/api/content/` and `/api/photo/` for `reader` callers and returned flagged to `owner` callers, rendered dimmed with an **Unhide** action. Hidden posts still participate in dedup.
  - **Pulled forward to Stage 1 — edit, hide, and delete now ship.** The read half of hiding was already built and enforced in four places, but nothing could *set* `hidden` except the DKIM hold in ingest, so taking a letter down meant editing `posts.json` by hand in Storage Explorer. That left [Moderation / quarantine](#moderation--quarantine) resting its whole hands-off argument — *"equally fixable post-publish through the standard edit/hide/delete tools"* — on tools that did not exist. `PATCH` and `DELETE` on `/api/posts/{slug}/{postId}`, with provisional controls in the reader. **Two things found while building it are worth remembering:** re-sanitizing an already-rendered body stripped every `<img>` (its `src` is an `/api/photo/` URL by then, not a `cid:`), so a one-character typo fix would have silently deleted every photo in the letter — hence `sanitizeBody`'s `keepPhotoPrefix`, pinned to the editor's own slug. And `bodyText` still ships to readers, so anonymizing `bodyHtml` would have published the removed name anyway out of a field the owner is never shown; editing the body now drops it.
  - **Still outstanding from this bullet:** hidden posts are badged rather than dimmed, and there is no admin surface for `editedBy` / `editedAt` — they are written, and only readable in the blob.
- **Restore original** per [Restoring the original](#restoring-the-original): owner-only, one post at a time, re-runs render from `raw/` and overwrites the post. Confirmation names whose edits are being discarded; `editedBy` / `editedAt` clear and `hidden` is preserved.
- **Site deletion** per [Post-mission archive](#post-mission-archive): typed confirmation stating the 30-day erase in plain words, immediate removal from every read path, and a timer that hard-purges blobs and soft-deleted versions at day 30 — **including `books/{slug}/` and the site's `memberships` rows**, which are easy to leave behind. **The identity and the role already exist**: the custom role `P-Day Letters Blob Purge` and the user-assigned identity `mj-id-purge` were created on 2026-08-05 when the ingest identity was narrowed off `permanentDelete`. What remains is to attach that identity to the function app and have the timer ask for it explicitly by client ID — the shared credential in `store.js` must not be repointed at it. **`allowPermanentDelete` is settled: it stays on.** See the deletion notes under [Owner-only actions](#post-mission-archive).
  - **Shipped 2026-08-06.** `DELETE /api/site/{slug}`, owners only, with the typed archive name as confirmation; the `deletions` table holding one row per pending erase; and a nightly `erase` timer at 04:15 UTC that empties `raw/`, `rendered/`, `config/`, `exports/` and `pending/` under the slug — base blobs *and* every version, in that order, because a version that is still current refuses both the soft delete and the permanent one.
  - **"Stops resolving at once" is `acl.json` being deleted, not a flag.** The blob is copied aside to `config/{slug}/deleted-acl.json` first, then the `memberships` rows go. Nothing gains a hot-path read, every existing authorization path refuses instantly because it already reads the ACL first, and versioning makes all of it recoverable. A `deleted: true` flag would have needed every caller to remember to check it.
  - **The slug is not reserved afterwards**, which is the deliberate answer to "what happens to a letter forwarded to a deleted archive": it starts a fresh pending site, exactly as the first letter for any archive does. No tombstone, no permanent grudge against a name.
  - **Which creates a thirty-day fuse, and the guard for it is `acl.json`.** A recreated site claimed on day twenty promotes into `raw/` and `rendered/` under the same slug, and the outstanding appointment would destroy a new family's letters. So the eraser refuses if an ACL exists, logs it as an error, and *cancels* the record rather than retrying — the appointment will never become appropriate again. `restoreSite` refuses on the same condition, with a `409`, for the same reason.
  - **No owner-facing undo, on purpose.** A visible undo button would make "it cannot be undone" a lie, and families would start treating deletion as reversible. What exists is a silent safety net with an operator-only door: `/manage` lists what is still recoverable, soonest to expire first, and restores it. Nothing links to that page and the API answers `404` to everyone not on `OPERATOR_EMAILS`.
  - **Nobody else on the ACL is emailed**, matching member removal. And **any owner may delete** — the `verifiedMissionary` protection guards membership, not the archive itself.
  - **`books/{slug}/` is listed in the code and not yet in the sweep**, because the container does not exist until Journal Publish. When it is created it must be added to `ERASED_CONTAINERS` *and* to `purgeContainerNames` in `main.bicep`, in that order, so a miss fails on a permission rather than silently skipping a container.
  - **Still outstanding:** the `exports/` lifecycle rule shipped with this (7 days, folded in from the Stage 1 loose end), but operator-initiated deletion of somebody else's archive is only available through the owner path an operator already resolves into.
  - **A deleted archive now says so, and did not.** Found by running the whole flow against a real archive on 2026-08-11. Deletion removes `acl.json`, and `resolveAccess` grants `owner` from `OPERATOR_EMAILS` *after* the ACL yields nothing — so an operator reads a deleted archive in full, which is correct and wanted, since somebody about to restore one needs to look at it first. What was wrong is that the page said nothing: the ordinary operator banner, the letters, the photos, the search box, and no hint that the archive was deleted or that everything on screen would be destroyed on a named date. **The one person who can undo the deletion was the one person not being told it had happened.** `deletionOf` is a point read taken only when `viaOperator` is true, so no ordinary reader pays for it — and nobody else can be looking at a deleted archive in the first place.
    - **It had to go into the ETag salt, and that is the sharper half of the fix.** Deleting an archive writes nothing to `posts.json`, so the blob ETag is unchanged, and `viaOperator` was already true for an operator reading a stranger's site — the two responses were indistinguishable to the cache. An operator with the page open from a minute earlier would have revalidated into a `304` and been handed back the copy with no notice on it, at exactly the moment the notice is the entire point.
    - **`post.js` had to salt identically**, which is the part that would have been missed. The edit path recomputes the validator to check `If-Match`, so a salt applied in one place and not the other turns into a phantom "the page you edited is out of date" for an operator correcting a letter on a deleted archive — a conflict about nothing, since not one byte of the letters had moved.
  - **Testing deletion on a real archive cannot demonstrate the refusal, and that is worth knowing before writing the next test script.** The manual pass said "confirm you are refused"; the tester is the operator, the operator override resolves above the ACL, and on this archive the only ACL member *was* the operator. There was no account left that could observe the refusal. The honest check is the storage state — `acl.json` gone, the `memberships` row gone — which is what was verified instead. **A service with an operator role cannot be tested for refusal by its operator**, and any step that asks for that is measuring nothing.
- **Invitations** per [Invitations](#invitations): bulk paste-and-parse, one signed single-use email per invitee naming the inviting owner, identity binding on acceptance rather than address matching, `invited` / `active` state in the admin list, and manual owner-initiated resend that invalidates the prior token. **Capped per site and per day**, since an uncapped bulk field is an outbound-mail cannon pointed at the sending domain's reputation.
  - **Shipped 2026-08-05, early, because `hello@` unblocked it.** This was meant to wait behind the rest of Phase 8; the sending identity was the only real dependency, and once that existed an archive readable by exactly one person was the most conspicuous thing left. Identity binding, the single-use token, the named inviter, the pending list, revocation, and the cap are all built and deployed. See [Invitations](#invitations) for where the implementation departs from the design — most notably that pending invitations live in their own table and never in `acl.json`.
  - **The cap is 20 per site per UTC day**, refused before the send and returned as `429`. The number is arithmetic rather than taste: the sending plan includes 3,000 messages a month, so one site sustaining twenty a day consumes a fifth of it and is visible in the logs long before it is expensive, while a hundred a day would eat the lot. It also has to clear a real family in one sitting, which is the failure actually worth caring about — the cap is tested from below as well as above.
  - **The cap counts issued rows, including revoked ones, which is why revocation is a tombstone.** A cap counting only surviving rows is reset by the revoke button, and invite/revoke/invite is then a loop with no upper bound: the withdrawal control becomes the exploit. Worth stating because the naive implementation is the wrong one and looks right.
  - **It is an upper bound plus concurrency, not an exact count.** Two requests in flight can each read the same total and both pass. Making it exact needs an atomic counter the table wrapper does not expose today, and a reputation guard measured over a day is not sensitive to being off by the handful of requests one browser can have open.
  - **Bulk paste-and-parse, `invitedEmail`, and the one-click opt-out shipped 2026-08-05**, each described in [Invitations](#invitations). The opt-out arrived here rather than in Phase 8 because an invitation is the only mail the service sends that its recipient did not ask for, so it is the only one that cannot wait for a preferences page.
  - **Owner-initiated resend shipped 2026-08-05**, per the four properties in [Invitations](#invitations).
- **Removing and promoting members** — not previously in this plan as a separate item, and built alongside invitations because *"an owner can revoke"* above quietly assumed it. An owner may remove anyone and change anyone's role, with two rules: **nobody may change their own membership**, and **the verified missionary cannot be removed or demoted by anyone**.
  - **The self-rule is what makes a zero-owner archive impossible, and there is no separate last-owner check.** Every removal is somebody removing somebody else, so the last owner cannot be removed by construction. It is stated here because the absence of that check looks like an oversight and is not.
  - **Self-*demotion* is blocked as well as self-removal**, which is a small extension: demoting yourself out of the only owner seat is removal with extra steps, and permitting it would require the last-owner check the rule above avoids.
  - **Member lists are owners-only.** A reader shown the list would be shown every relative's email address.
  - **Removal sends no email.** Being told you have been removed from a family's archive is a message the family should get to write themselves.
- ~~Owner-managed profile: display name, optional `returnDate`, and `alternateSenders` for missionaries writing from a personal account.~~ **Display name and `returnDate` shipped; `alternateSenders` deliberately not.** The name is set once during a claim and was, until now, permanent — a typo in the string that heads every page, titles the tab, labels the archive on the root list, and goes out in the subject line of every invitation, with no way to correct it. `/settings/{slug}` and `GET`/`PUT /api/profile/{slug}` fix that, owners only.
  - **`profile.json` is the record and the `sites` row is the index**, the same relationship `acl.json` has with `memberships`, and getting this backwards was a real bug rather than a tidiness question. The rename before this one wrote only the table; `tools/rebuild-memberships.js` restores the name *from the blob*, so a repair run would have silently reverted an owner's rename — on the one code path that exists precisely because something has already gone wrong. Writing the blob first and mirroring second also means a failed mirror leaves the record correct and the index stale, which the repair tool fixes; the other order leaves the index holding a name no file agrees with.
  - **`alternateSenders` is carried through untouched and given no control.** It is in the file, seeded empty, and nothing reads it — routing keys on `@missionary.org` alone. A field that appears to decide who may publish into an archive and in fact decides nothing is a lie with the shape of a security setting, so it gets a UI when it gets an implementation. The only property tested is that editing the name does not delete it.
  - **A name cannot contain a newline.** It is pasted into the subject header of every invitation, which makes an unfiltered newline header injection. Refused at the boundary rather than trusted to the six places that consume the name.
  - **`returnDate` is absent rather than empty when unset**, because absent means "derive it from the letters" and that is a different statement from "there is no return date". A blank string would make the two indistinguishable.
  - **The gate was factored out rather than copied a third time.** `members.js` carried its own identity/slug/role check with a comment explaining why it could not use `gate()` — `gate` reads `posts.json` and refuses when it is missing, which would mean "you cannot rename your archive until the first letter renders". That check is now `siteGate` in `api.js`, used by both.
- **Ownership-window UI** per [Ownership and the 60-day window](#ownership-and-the-60-day-window): ~~enforce `verifiedMissionary` removal protection~~ **(shipped with member removal — the flag is set only by the `claim@` path, and a pending redemption deliberately writes it `false`, because the protection it confers is too strong to hand out on that evidence)**; persistent banner while any owner is on `missionary.org`; standing prompt to get the missionary claimed while their address still works.
- **Operator authorization** per [Service operators](#service-operators): `OPERATOR_EMAILS` resolves to `owner` inside the shared authorization function from Phase 3, above the `acl.json` lookup and with no write to `acl.json` or `memberships`. Includes the `/manage/last-received` service-wide view, the "acting as operator" banner, `OperatorAction` telemetry on reads as well as writes, operator site deletion with a recorded reason, and `verifiedMissionary` removal blocked for operators exactly as for owners. The email path is untouched — forwarding rights stay `acl.json`-only.
  - **Shipped 2026-08-06, minus the two pieces that belong to work not yet done.** The setting, the resolution, the banner and the audit event are all built and deployed; `/manage/last-received` and operator site deletion wait on Phase 12 and on site deletion itself, and the `verifiedMissionary` protection already applies to operators for free, because an operator is an owner by the time `members.js` sees them and that rule refuses owners.
  - **The authorization function now returns `{ role, viaOperator }` rather than a role.** The flag is the thing a bare role cannot carry: that some or all of this authority came from an app setting rather than from the family's own list. It drives both the banner and the audit event, and `resolveRole` remains as a one-line wrapper for the callers with no use for where the role came from. **The ACL is read first**, so the answer for everybody who is not an operator — which is everybody — is byte-for-byte what it was before operators existed.
  - **An operator who is only a *reader* on a site still gets `owner`, and is still flagged.** Their own family's archive, where they are an ACL owner, is not flagged at all: a warning that fires when nothing is wrong is one people learn to stop reading. But reader-plus-operator is the one arrangement where the owner powers came from the setting, so calling it unflagged would let operator authority go unannounced.
  - **The audit event is emitted from inside the two gates, not from each endpoint.** A trail a caller has to remember to write is one an endpoint added next year will not have; every route that authorizes through `gate`/`siteGate` is covered by construction. It is `log.warn('OperatorAction', …)` with actor, slug, method, route and timestamp — `warn` because nothing here takes a dependency on the App Insights SDK, so it lands in `traces`, and severity is the only thing separating it from the chatter it would otherwise be buried in. **The route is logged without its query string**, since nothing behind these gates takes a token in the URL today and a log line that would start carrying one is not worth writing.
  - **`viaOperator` went into the `posts.json` ETag salt**, which was not obvious and is not cosmetic. The salt already carried the role, because owners and readers get different bodies. The flag changes the body too — it decides whether the page says out loud that somebody is reading an archive they do not belong to — and `Cache-Control: private, no-cache` means every load is a revalidation that reuses the cached body on a 304. Without the salt, an operator removed from a family's ACL would keep revalidating into a copy with the warning switched off. Salting with `false` is a no-op string, so no existing browser cache was invalidated by the change.
  - **Not memoized.** Splitting a forty-character setting is far cheaper than the blob read beside it, and a cached copy would mean an operator removed from the list keeps their access until the host happens to recycle — the moment the removal matters most.
  - **Unset means nobody**, tested from that direction explicitly. An empty or whitespace setting produces an empty set, never a wildcard, and that is what every environment except production runs with. The parse accepts commas, semicolons and whitespace because the value is typed into a portal text box by a human who will not be reading a format specification at the time.
  - **The parameter is restated in `main.bicepparam` rather than left to its default**, for the reason already learned with `MAIL_ALLOWLIST`: `what-if` cannot see `siteConfig.appSettings`, so an omitted parameter blanks the setting on the next deployment. Here that direction is safe — it revokes rather than grants — but it would revoke silently, and the failure would surface as the operator locked out of the archive they were in the middle of fixing.
- **Credential expiry has to announce itself.** The Entra client secret behind Microsoft sign-in expires **2028-08-04** and will fail exactly the way the missing ID-token grant did — silently, at the callback, with Google still working, and with nothing in the repo pointing at the cause. Key Vault now carries the real date on `aad-client-secret`, so the remaining work is to honour it: route Key Vault's `SecretNearExpiry` Event Grid event (fired 30 days out) to a notification, and treat the vault as the one place that knows when anything expires. **The Cloudflare send token (`cloudflare-api-token`) is the second of these and expires sooner — 2027-08-31.** Its failure is quieter still: sends return `10101 unauthorized`, which the mailer logs and swallows by design, so nothing breaks, no letter is lost, and claim emails simply stop reaching anybody. The first evidence would be a pending site expiring unoffered, which is the one outcome the purge timer was written to shout about — an alert arriving sixty days after the cause. Set the expiry date on the Key Vault secret so the vault knows it, the same way `aad-client-secret` does. Three things measured while setting this up, all of which change what is worth building:
  - **Key Vault serves an expired secret quite happily.** `exp` is advisory for secrets, not enforced on read — so an early date is a warning, not a scheduled outage, and can be set deliberately ahead of the true expiry.
  - **Key Vault cannot renew either of these.** Auto-renewal is a certificates-only feature for integrated CAs; it has no way to ask Entra or Google for a fresh client secret. Real rotation would be a Function on the near-expiry event calling Graph — worth it for many secrets, hard to justify for one that fires every two years.
  - **`google-client-secret` deliberately carries no date**, because Google OAuth client secrets do not expire. Setting one to look tidy would manufacture a false alarm.

### Phase 10 — New-letter notifications
**Not started.** Blocked behind Phase 8 — nothing can be notified until something can send.

- **Monthly digest** per [New-letter notifications](#new-letter-notifications): timer-triggered Function, one email per user spanning all of their sites, and the existing one-click HMAC opt-out. Carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers, which bulk mail now needs for inbox placement.
- **`digestFrequency` is collected, not defaulted** — add the monthly/weekly/never question to the invitation-acceptance and claim flows from Phases 7 and 9, with `monthly` preselected, plus a control on `/settings`. Rows created by ingest are set `off` and never prompted.
- **Empty digests are never sent.** Verify by letting a test site sit through a full cycle with nothing published and confirming no mail leaves.
- **Verification:** put one recipient on two sites, publish to one, and confirm a single email arrives describing both sites' new content correctly. Back-date `lastPostAt` to check the window boundary. Follow a digest link with an expired session and confirm the `401` flow lands on the intended post. Hide a post and confirm it never appears in a digest.
- **Stretch — SMS.** Not started until the digest ships and the cost, A2P registration, and `STOP`-handling questions in [Text messages](#text-messages-stretch) have answers. Per-post rather than digested, default off, number confirmed by a round-trip code.

### Phase 11 — Journal Publish
**Not started.**

- Assemble a hardcover photo book from a missionary's posts + photos and place the print order via the Lulu Print API.
- Built from the same filtered payload the reader UI receives, so hidden posts are excluded without a rule of its own — see [Editing and hiding posts](#editing-and-hiding-posts).
- Full design in [Journal Publish](#journal-publish), including why Shutterfly + Rakuten was ruled out.

Phase 12 is [Leaving beta](#phase-12--leaving-beta), and it is deliberately the last section of this document rather than the next heading — see the note there.

---

## Reader UI backlog

Raised after reading the first real archive end to end, and recorded here so they are not lost. **None of these are refined yet, and none of them block anything.** They want another pass before friends start using the site — the honest summary of the current reader is that *"it feels less like a blog and more like a massive brain dump."*

The framing matters more than the individual items: the page is one long unbroken column, and length is the problem the ideas below are each attacking from a different side.

1. **Inline photos with text wrapped around them.** Show the small rendition in the flow of the letter rather than in a block underneath, with the text wrapping, and put a visible affordance on the image saying that clicking it opens the larger one. Today an image is either inline (because the letter placed it there) or relegated to the album strip at the bottom, and neither says it can be enlarged.

   **The split itself is confirmed working.** A letter carrying one pasted inline image and two attachments rendered exactly that way end to end — the pasted one in the flow, the other two in the album. So nothing here is about *which* pictures go where; it is entirely about how the inline one is presented. It currently sits at full width, breaking the column and pushing the text apart, when it should be small, wrapped, and obviously clickable.

2. **Highlight search hits and let the reader step between them.** Search currently hides non-matching letters, which answers "which letters mention this" but not "where in this letter". Wants the matches marked, next/previous navigation, and a **floating search control that does not scroll away** — with the page this long, scrolling back up to the search box is most of the cost of searching.

3. **Collapsible letters, collapsed by default.** All but the most recent start closed. A letter containing a search hit expands when the reader advances to that hit. Explicitly thinking out loud — there may be a better shape than collapse, and the goal is the outcome (a page you can survey at a glance) rather than the mechanism.

4. **Rework the per-letter album into a flatter carousel.** The album is a vertical strip under each letter, so every photo a missionary sends adds directly to the length of a page that is already too long — a letter with eight pictures buries the next letter under them. Wanted instead: a low, horizontally scrollable row that occupies roughly fixed height whatever the photo count, with the same click-to-enlarge behaviour item 1 asks for. This pulls in the same direction as items 1 and 3 — the album is one of the two things making a single letter tall, and the only one that grows without bound.

   Two constraints it has to respect. It must work from `file://` with no `fetch`, no modules and no build step, like everything else in the reader. And it must stay usable by touch and by keyboard, because a horizontal strip is the control most likely to end up mouse-only by accident.

Two things not to lose when this is reworked:

- **The offline archive shares `web/reader.js` verbatim** — the byte-equality test in the suite exists to keep the downloaded copy from drifting. Anything added here has to work from `file://`, which rules out `fetch()`, ES modules, and anything that needs a server.
- **The owner controls added alongside the moderation API are provisional** and were built to be replaced. They render only when `mount()` is given an `admin` object, so the archive never draws them. The edit control has since been [rebuilt to edit the letter in place](#the-editor-edits-the-letter-not-its-markup); the surrounding layout has not.

A sort-order bug was reported here and then withdrawn — the letters are chronological, newest first, and that was confirmed against the live data independently. See the note on offset-fragile date comparison under [Phase 6](#phase-6--direct-ingest) before that phase lands.

### The editor edits the letter, not its markup

The first edit control was a `<textarea>` holding raw `bodyHtml`. That is workable for someone who reads HTML and unusable for everyone else, and "everyone else" is the entire intended audience — the owner is typically a parent, not a developer. It has been replaced by **editing the letter in place**: the already-rendered body becomes `contenteditable`, and the subject becomes a single-line field standing where the heading was. Reasons it fits this system specifically:

- **The server stays the authority regardless.** Whatever HTML a browser produces goes through the same sanitizer and the same allowlist as a stranger's forwarded email, so a rich editor adds no trust and needs no exception. The pasted-from-Word disaster that usually sinks `contenteditable` is already handled: every `style`, `class`, `font` and `id` is stripped, and the [tidying pass](#tidying-the-markup-mail-clients-invent) removes the `<div><br></div>` scaffolding `contenteditable` itself emits.
- **No dependency and no bundler.** The CSP is `script-src 'self'`, and the archive constraint above rules out anything needing a build step. A vendored rich-text library is possible but is a large amount of surface for what owners actually do: fix a typo, cut a paragraph, remove a name, delete a photo.
- **Photos become directly manageable.** In the textarea a picture is an `<img>` tag among the prose; in place it is a picture you can select and delete, which is the one destructive edit most likely to be wanted and most likely to be got wrong by hand.

The subject stays a field of its own rather than becoming an editable heading. It has to survive as one line, and an editable `<h2>` invites a paragraph break the data model has nowhere to put.

Two things had to be built rather than inherited from the browser, both because they were measured and found missing, not assumed:

- **The formatting shortcuts are bound explicitly.** The intent was to offer no toolbar and rely on Ctrl/Cmd+B, I and U, which every browser is supposed to handle inside `contenteditable`. Tested against a real letter, the chords produced nothing at all — the keystroke arrived and no editing command ran. `document.execCommand` itself worked fine when called directly, so the binding, not the command, was missing. They are now bound in the reader. That also pins down the *result*: browsers that do handle these have historically emitted `<span style="font-weight:bold">` rather than `<b>`, and the sanitizer strips `style`, so the owner would have pressed the key, seen bold text, saved, and got plain text back with nothing to explain it. `styleWithCSS` is turned off for the same reason.
- **Clicking a photo selects it.** By default a click near an image only places the caret beside it, so pressing Delete does nothing and the owner is left prodding at a picture that will not go away. The reader now selects the image node on click, which is what the pointer cursor promises.

**Save still reloads the page, deliberately.** Editing in place means the result is already on screen, so this looks removable — but the server is the thing that decides what the letter finally contains, and its answer can differ from what was typed. More importantly the page holds the `ETag` it loaded, which is what stops one owner's save from silently overwriting another's; after a successful write that value is stale, and a second edit in the same session would be rejected as a conflict. The reload refreshes both. Removing it means reading the new `ETag` and the sanitized body out of the response instead, which is worth doing and is not free.

What the browser produces was checked against the server end to end rather than reasoned about: a real letter was edited in place — bold, italic and underline applied by shortcut, a photo deleted, the subject changed — and the exact bytes the page sent were run through `applyEdit`. Both remaining photos, all three formatting tags and the album link survived, no empty blocks were left, `bodyText` was dropped, and a second save changed nothing. The photos matter most: the page displays them through whatever URL its host uses, which in the downloaded archive is a relative path and on the site is `/api/photo/...`, so the editor keeps the stored URL on each image and puts it back before sending. Reading the displayed markup back directly would work on the website today and would delete every picture in a letter the day it stopped matching, because the sanitizer drops an `<img>` whose `src` it does not recognise.

Still open: there are no automated tests over any of this. `reader.js` runs in a browser and the repo has no DOM test harness, so the verification above was done by driving a real page and is not repeatable in CI. Adding one means taking a dependency such as `jsdom` — a decision worth making deliberately rather than in passing, given the photo round-trip is exactly the kind of thing that breaks silently.

---

## Open questions to confirm

Feature-specific questions stay with their own sections. This one spans the service:

1. **There is no way to contact a human.** Every path in this document that ends in "a service operator decides" — an abuse report, an ownership dispute after the [60-day cliff](#the-60-day-cliff), a missionary who finds a site about themselves — assumes the person can reach us, and nothing anywhere tells them how. [pitch.md](pitch.md) doesn't either. The likely answer is a monitored address on the public landing page and in the email footer, but it needs deciding before the pilot rather than after: the first person who needs it will be the one least able to wait.

2. **~~Is Cloudflare's outbound header allowlist compatible with the design?~~ Answered: yes, from documentation, without sending anything.** All five headers Phase 8 needs are explicitly allowlisted — `In-Reply-To` and `References` under threading, `Auto-Submitted` under automated-message identification, and `List-Unsubscribe` / `List-Unsubscribe-Post` under list management. Two constraints come with them: `List-Unsubscribe` must carry an angle-bracketed `https:` or `mailto:` URI and plain HTTP is refused, and `List-Unsubscribe-Post` must be exactly `List-Unsubscribe=One-Click`, case-sensitive. **This question was written to be settled by an experiment and was settled by reading the reference page instead** — the same lesson as the fixture in Phase 6, from the other direction: the evidence for a gating question is often already written down, and a probe is the expensive way to learn what a docs page states outright.

3. **~~Does `message.reply()` cover the ack path?~~ Answered: the guess was right.** `reply()` requires the incoming message to pass DMARC, and additionally allows one reply per event, requires the reply recipient to match the incoming sender and the sending domain to match the receiving domain, and refuses a message carrying more than 100 `References` entries. Acks to a relative forwarding from an old ISP account fall back to a normal send and lose their threading, as expected.

4. **~~`mailauth` carries four high-severity advisories with no fix available.~~ Answered: not reachable.** The advisories are real but the code they describe is not loaded. Requiring `mailauth/lib/dkim/verify` pulls in 109 modules, of which **`undici` accounts for zero** and `nodemailer` for exactly one — `lib/addressparser/index.js`, a pure parser that none of the four advisories touch. Every `nodemailer` advisory is about *sending*, which nothing here does. **This was measured rather than reasoned about**, after an earlier note in this document asserted the opposite from the shape of the dependency tree. **The residual noise now has a baseline rather than a threshold.** `npm audit` is permanently red on sixteen findings that will never be fixed, which is exactly the condition under which a real advisory gets scrolled past — so `functions/tools/audit-check.js` compares advisory *IDs* against `functions/audit-baseline.json` and fails the build only on one nobody has looked at yet. Counting would not have done: a count holds steady while one advisory is fixed and another appears. Each baseline entry carries the reason it is unreachable, because an entry without a reason is a silenced alarm.

---

## Phase 12 — Leaving beta

**Not started**, and deliberately last — not merely late in the running order but *the final section of this document*, so anything discovered later is written above it rather than after it. The [beta mark](#the-service-is-in-beta-until-the-privacy-policy-ships) stays until this ships, and this ships only when everything above it is done.

**The position is the point, not the number.** A phase near the end of a list is one a plan can quietly reorder around; a phase at the end of the document cannot be, because every new item has to be filed before it. That ordering encodes a commitment worth making explicit: **no known work outstanding when the beta mark comes off.** It sweeps in the things a numbered phase would have let us leave beside it — the [Reader UI backlog](#reader-ui-backlog), which blocks nothing technically and blocks showing the site to family in practice, and the [open questions](#open-questions-to-confirm), at least one of which is a policy question this phase would otherwise answer in prose while leaving unanswered in fact.

Written last for a second, independent reason: it has to describe what was actually built rather than what was planned. A privacy policy drafted from a design documents a system that does not exist, and the gap between the two is precisely where the untrue sentence ends up.

- **Terms of use:** who owns the content (the missionary and their family, never the service), what the service may do with it (store, render, print on request — nothing else), and the acceptable-use line.
- **Privacy policy:** what is retained and for how long, that `raw/` is kept indefinitely and deliberately, the 30-day erase window on deletion, that submitting a book discloses its contents to the print provider, and who can see what — **including that service operators can reach any site**, per [Operator access is visible and logged](#operator-access-is-visible-and-logged). That disclosure is the reason this cannot be boilerplate.
- **Takedown and dispute process:** the written policy behind the mechanism [The 60-day cliff](#the-60-day-cliff) already describes — what evidence is required, who decides, and what the outcomes are (add an owner, or delete the site).
- **Transactional-mail position:** a short statement that claim emails, acks, invitations, and digests are responses to a specific action rather than marketing, and that each carries an opt-out. **The mechanism half already shipped** — see [Invitations](#invitations) — so what remains here is the statement, not the plumbing.
- **Stand up the maintenance schedule in [todos.md](todos.md), and align every credential to a common expiry month.** Left alone, secrets expire on the dates they happened to be created, which means rotation is a task that arrives several times a year, unannounced, and is done under pressure each time. Aligning them converts that into one scheduled sitting. **This belongs here rather than earlier**: doing it while credentials are still being added guarantees redoing it, and the alignment is only meaningful once the set has stopped changing. It is the last thing to do before the item below.
- **Then remove the beta mark.** Publishing this is what ends beta. There is no separate announcement and no other gate.
