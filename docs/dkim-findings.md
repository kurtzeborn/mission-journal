# DKIM re-verification — findings

Measured research behind [the design plan](plan.md). This is the evidence for how `verifyEmbeddedDkim` and the ARC fallback are built; the plan itself only summarizes the conclusions.

The tables below are asserted by `functions/tests/dkim.test.js` and `functions/tests/arc.test.js` rather than left as research notes, so a change in any of these clients' behavior surfaces as a test failure. The assertions that need the pristine captures and a DNS lookup skip when the private repo is absent — which is every CI run.

## What re-verification actually recovers

Re-verification works, and it fails far more often than the design first assumed. Measured against the pristine captures in the private repo, splitting the body hash from the header signature, and reading the ARC chain:

| Specimen | `bh=` (body) | `b=` (headers) | ARC seal | Usable? |
| --- | --- | --- | --- | --- |
| Missionary's BCC, through Cloudflare | **pass** | **pass** | — | yes, in full |
| The same message, through Exchange Online | fail | **pass** | `microsoft.com` | yes, headers |
| Forward-as-attachment, Gmail web | **pass** | **pass** | `google.com`, `cv=pass` | yes, in full |
| Forward-as-attachment, Outlook web | fail | **pass** | `microsoft.com`, valid | yes, headers |
| Forward-as-attachment, Outlook desktop | fail | **fail** | chain truncated to `i=1` | **no** |
| Forward-as-attachment, Outlook Android | *no `DKIM-Signature` at all* | — | — | **no** |

RFC 6376 makes `bh=` and `b=` independent: one hashes the body, the other signs the header set. `mailauth` short-circuits on a body-hash mismatch and reports `neutral` without ever checking the signature, which is correct for a delivery decision and useless for this one. Checking the second half separately is what recovered the Outlook web path.

## Signatures expire, and an archive has to ignore that

A DKIM signature may carry an expiry in `x=`, and Google sets one about a week after `t=`. Checked against the wall clock — which is what every verifier does by default, because every verifier is deciding whether to accept a *delivery* — a letter stops verifying a few days after it was written. That is the exact opposite of what this service needs: it exists to re-verify letters forwarded months or years later, so by the time anyone asks, the answer is always "expired". Nothing about the letter has changed; the question was simply the wrong one.

The right question is not *"is this signature still valid today"* but *"was it valid when it was made"*, so the clock is set to the earliest `t=` the message itself carries. Earliest, not latest: a forward is signed again by the forwarder's provider at the moment of forwarding, and dating the check from that would put the clock years past the missionary's own expiry and lose the letter to the very rule being worked around. `t=` sits inside the signed header block, so moving it means forging the signature. What this gives up is replay protection — an expired signature verifies forever — and that is deliberate: a replay here is a letter the missionary genuinely did sign.

**The regression test signs its own letter.** This defect passed review and testing: the captures were taken and the tests written in the same week, when every signature was still inside its expiry window, so the suite went green and then broke a week later on code nobody had touched, with `mailauth` reporting a body-hash complaint that pointed nowhere near the cause. A test that depends on a message being old cannot be written against a fixture that is new, so the test mints a signature with a chosen `t=` and `x=` and is as stale as the question requires, permanently.

## What Exchange changes, exactly

Three artifacts, all in the body, totalling 79 bytes on a 190 KB message: a `<meta http-equiv="Content-Type">` prepended to the HTML part, a blank line after a nested multipart's closing delimiter, and a blank line after a base64 payload. `text/plain` parts are never touched. Reversing them reproduced Gmail's bytes exactly on one fixture and failed on a live message at every quoted-printable wrap width from 69 to 77 — an overfit, abandoned. The damage is also done *before* any forwarder acts: it happens in the Exchange store, on delivery, so no client-side fix exists.

## Why Outlook desktop is unrecoverable and Outlook web is not

Same letter, same `Message-ID`, captured through both. Outlook web altered **zero** signed headers. Outlook desktop altered four: the MIME `boundary` was regenerated, `To:` regained a display name, `Subject:` was re-encoded from Q to B, and `Date:` was converted to UTC. All four are inside `b=`. Desktop Outlook reconstructs the message from MAPI properties rather than sending on the bytes it received, so the original never leaves the machine and no parser can recover it. It also drops Microsoft's own ARC set, leaving a one-entry chain.

## Why the seal alone is not enough, and why the header signature alone is not either

`ARC-Seal` does not cover `From:`, and Microsoft's sealed record names only the domain — checked directly, there is no local part in it:

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

## Coverage, not just a verdict

`verifyEmbeddedDkim` returns `coverage: 'body' | 'headers' | null` alongside `verified`. `body` means the published words are the signed words. `headers` means only that the letter is from the address and date it claims — the text may since have been rewritten, and on the Outlook path it demonstrably has been. Both are logged. A run of `headers` where there used to be `body` is a provider having changed something.

## Prior art

The Thunderbird DKIM Verifier add-on (`lieser/dkim_verifier`) hits exactly this, and its maintainer's only workaround after years is an option to trust the plaintext `Authentication-Results` header — strictly weaker than checking a seal. The same project independently proposed splitting `bh=` from `b=`. The Exchange body rewrite has been reported to Microsoft at least three times since 2017: a Q&A post with a `dkimpy` before/after proof, a 2023 support case that went quiet, and a 2024 TechCommunity post with one Like and no replies. A third-party Outlook library ships code to undo the injected `<meta>` tag, which only works because it runs inside Outlook on the sender's machine. Nine years, no acknowledgement.

## Would Microsoft 365 as our MX have avoided this?

No, and it would probably have hurt. The Gmail capture's own ARC chain settles it: `google.com` (origin) → `cloudflare-email.net` (our MX) → `google.com`, with the final hop re-verifying `missionary.org`'s signature *after* Cloudflare's and still passing. Cloudflare is byte-transparent. Microsoft's sealed record on the same letter also said `dkim=pass`, so the letter was intact on arrival and broke in their store. Exchange is the mangler, not the transport; Defender's Safe Links and Safe Attachments would operate on the `message/rfc822` part we need untouched, putting the Gmail path that works today at risk; and mechanically it is worse — Cloudflare Email Workers hand us raw MIME synchronously, where Graph would mean polling for `$value`.
