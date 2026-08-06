// Re-verifying the embedded original's own DKIM signature.
//
// A forward reaches us through the forwarder's mail client, so DMARC at our
// edge speaks only about the forwarder. It says nothing about whether the
// letter inside is genuinely the missionary's. The embedded original carries
// its own signature over its own headers and body, and that signature is the
// only evidence of authorship that survives being forwarded.
//
// Failure is expected and is not treated as an attack. Keys rotate, clients
// mangle whitespace, and a letter forwarded years later may be signed by a key
// that no longer exists in DNS. An unverified original is held for the owner
// rather than dropped -- see classify.js.

import crypto from 'node:crypto';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import { domainOf } from './authresults.js';
import { verifyArcSeal } from './arc.js';

// mailauth is CommonJS and publishes no exports map, so the subpath is
// required rather than imported.
const require = createRequire(import.meta.url);
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const { getPublicKey } = require('mailauth/lib/tools');

/**
 * How much of the letter the evidence actually covers.
 *
 * The distinction is not pedantry. `body` means the words being published are
 * the words that were signed. `headers` means only that the letter came from
 * the address it claims, on the date it claims -- the text may since have
 * been rewritten, and in the Outlook case it demonstrably has been.
 */
export const COVERAGE = { body: 'body', headers: 'headers' };

// The signature has to be the author's own. A forward is frequently signed by
// the forwarder's provider as well, and that signature verifies perfectly
// while proving nothing about who wrote the letter -- counting it would turn
// "anyone with a Gmail account" into "anyone who can publish as a missionary".
//
// A subdomain of the author's domain is accepted because large mail systems
// sign that way; anything else is not.
const signedByAuthor = (signingDomain, authorDomain) => {
    if (!signingDomain || !authorDomain) return false;
    const signer = signingDomain.toLowerCase().replace(/\.$/, '');
    return signer === authorDomain || signer.endsWith(`.${authorDomain}`);
};

/**
 * A DNS resolver for DKIM public-key lookups.
 *
 * Defaults to the platform resolver, which is correct in Azure. The override
 * exists because some local networks refuse outbound DNS from Node, which
 * surfaces as `temperror` and looks exactly like a signing key that has been
 * withdrawn -- an ambiguity worth being able to eliminate while debugging.
 *
 * @param {string[]} [servers] explicit nameservers, e.g. ['1.1.1.1']
 */
export function createResolver(servers) {
    const list = (servers ?? [])
        .map((s) => String(s).trim())
        .filter(Boolean);

    if (!list.length) return dns.promises.resolve;

    const resolver = new dns.promises.Resolver();
    resolver.setServers(list);
    return (name, rr) => resolver.resolve(name, rr);
}

// Built once, on first use rather than at import, so the environment is read
// after the host has finished populating it.
let cachedResolver = null;
const defaultResolver = () =>
    (cachedResolver ??= createResolver((process.env.DKIM_DNS_SERVERS ?? '').split(',')));

/**
 * Check `b=` alone -- the signature over the headers -- ignoring `bh=`.
 *
 * RFC 6376 makes these independent: `bh=` is a hash of the body, `b=` is a
 * signature over the signed header set. mailauth never reaches the second
 * because it short-circuits on a body hash mismatch and reports `neutral`,
 * which is correct for delivery decisions and useless for ours. Exchange
 * rewrites bodies and leaves headers alone, so for an Outlook forward this is
 * the only signature evidence that survives, and it is real: From, Date,
 * Subject and Message-ID are all inside it.
 *
 * Everything needed is already on mailauth's result -- the canonicalized
 * header block it built to check `b=` with, and the algorithm and selector
 * from the signature -- so this re-does the key fetch and the verify, and
 * nothing else.
 *
 * Failure is swallowed. This runs only after verification has already failed
 * once, so there is no verdict to lose, and a withdrawn key or a malformed
 * result must not turn a held letter into a crashed ingest.
 */
async function headerSignatureHolds(result, resolver) {
    try {
        const canonicalized = Buffer.from(result.signingHeaders.canonicalizedHeader, 'base64');
        const key = await getPublicKey(
            'DKIM',
            `${result.selector}._domainkey.${result.signingDomain}`,
            1024,
            resolver
        );

        // Ed25519 signs the digest; RSA signs the block and names its hash.
        const [type, hash] = String(result.algo ?? '').split('-');
        return crypto.verify(
            type === 'rsa' ? hash : null,
            type === 'rsa' ? canonicalized : crypto.createHash('sha256').update(canonicalized).digest(),
            key.publicKey,
            Buffer.from(result.signature, 'base64')
        );
    } catch {
        return false;
    }
}

/**
 * @param {object} extracted result of extractOriginal()
 * @param {object} [options]
 * @param {function} [options.resolver] (name, rrtype) => Promise<records>
 * @param {string[]} [options.trustedSealers] ARC sealers whose word is accepted
 * @returns {Promise<{verified: boolean, coverage: string|null, reason: string, signatures: object[]}>}
 */
export async function verifyEmbeddedDkim(extracted, { resolver, trustedSealers } = {}) {
    // Only an embedded original has a signature of its own to check. Inline
    // forwarded text was re-typed by the client and carries no signature at
    // all, which is precisely why it cannot start an archive.
    if (extracted?.source !== 'rfc822' || !extracted.embeddedBytes?.length) {
        return { verified: false, coverage: null, reason: 'no-embedded-original', signatures: [] };
    }

    const authorDomain = domainOf(extracted.original?.from);
    if (!authorDomain) {
        return { verified: false, coverage: null, reason: 'no-author-domain', signatures: [] };
    }

    const resolve = resolver ?? defaultResolver();

    let outcome;
    try {
        outcome = await dkimVerify(Buffer.from(extracted.embeddedBytes), { resolver: resolve });
    } catch (err) {
        // A malformed embedded message must not take down the ingest of a
        // letter we are otherwise willing to hold.
        return {
            verified: false,
            coverage: null,
            reason: 'verify-threw',
            error: err.message,
            signatures: []
        };
    }

    const results = outcome?.results ?? [];
    const signatures = results.map((r) => ({
        domain: r.signingDomain ?? null,
        selector: r.selector ?? null,
        result: r.status?.result ?? null,
        comment: r.status?.comment ?? null,
        alignedWithAuthor: signedByAuthor(r.signingDomain, authorDomain)
    }));

    if (!signatures.length) {
        return { verified: false, coverage: null, reason: 'no-signature', authorDomain, signatures };
    }

    const passing = signatures.find((s) => s.result === 'pass' && s.alignedWithAuthor);
    if (passing) {
        return { verified: true, coverage: COVERAGE.body, reason: 'pass', authorDomain, signatures };
    }

    // The body hash failed but the headers may not have. mailauth reports
    // `neutral` for precisely that case and `fail` when the signature itself
    // is wrong, so only `neutral` is worth a second look -- re-checking a
    // signature already known to be bad would be asking a different question
    // and getting the same answer.
    const recoverable = results.filter(
        (r) => r.status?.result === 'neutral' && signedByAuthor(r.signingDomain, authorDomain)
    );

    for (const result of recoverable) {
        if (!(await headerSignatureHolds(result, resolve))) continue;

        // Headers hold, so the letter is from who it says on the date it says.
        // That still leaves the body unaccounted for, and a body nobody
        // vouches for is a body anyone could have written. The seal is what
        // closes it: the provider that rewrote the body signed a record of
        // having verified the original in full.
        const arc = await verifyArcSeal(outcome.arc, { resolver: resolve, trustedSealers });

        const attestsAuthor =
            arc.sealed &&
            arc.attested.dmarcPass &&
            signedByAuthor(arc.attested.dmarcFromDomain, authorDomain) &&
            arc.attested.dkimDomains.some((d) => signedByAuthor(d, authorDomain));

        if (attestsAuthor) {
            return {
                verified: true,
                coverage: COVERAGE.headers,
                reason: 'pass-headers-sealed',
                authorDomain,
                signatures,
                arc
            };
        }

        return {
            verified: false,
            coverage: null,
            reason: `headers-pass-but-${arc.reason}`,
            authorDomain,
            signatures,
            arc
        };
    }

    // Distinguished so the logs can tell "the key is gone" from "the bytes
    // were altered" from "nobody signed as the author at all". These have
    // very different implications and only one of them is suspicious.
    const aligned = signatures.filter((s) => s.alignedWithAuthor);
    const reason = !aligned.length
        ? 'no-author-signature'
        : aligned.some((s) => s.result === 'temperror')
            ? 'dns-temperror'
            : `author-signature-${aligned[0].result ?? 'unknown'}`;

    return { verified: false, coverage: null, reason, authorDomain, signatures };
}
