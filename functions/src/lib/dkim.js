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

import dns from 'node:dns';
import { createRequire } from 'node:module';

// mailauth is CommonJS and publishes no exports map, so the subpath is
// required rather than imported.
const require = createRequire(import.meta.url);
const { dkimVerify } = require('mailauth/lib/dkim/verify');

const domainOf = (address) => {
    const at = String(address ?? '').lastIndexOf('@');
    return at < 0 ? null : address.slice(at + 1).toLowerCase().replace(/\.$/, '');
};

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
 * @param {object} extracted result of extractOriginal()
 * @param {object} [options]
 * @param {function} [options.resolver] (name, rrtype) => Promise<records>
 * @returns {Promise<{verified: boolean, reason: string, signatures: object[]}>}
 */
export async function verifyEmbeddedDkim(extracted, { resolver } = {}) {
    // Only an embedded original has a signature of its own to check. Inline
    // forwarded text was re-typed by the client and carries no signature at
    // all, which is precisely why it is owner-only.
    if (extracted?.source !== 'rfc822' || !extracted.embeddedBytes?.length) {
        return { verified: false, reason: 'no-embedded-original', signatures: [] };
    }

    const authorDomain = domainOf(extracted.original?.from);
    if (!authorDomain) {
        return { verified: false, reason: 'no-author-domain', signatures: [] };
    }

    let outcome;
    try {
        outcome = await dkimVerify(Buffer.from(extracted.embeddedBytes), {
            resolver: resolver ?? defaultResolver()
        });
    } catch (err) {
        // A malformed embedded message must not take down the ingest of a
        // letter we are otherwise willing to hold.
        return { verified: false, reason: 'verify-threw', error: err.message, signatures: [] };
    }

    const signatures = (outcome?.results ?? []).map((r) => ({
        domain: r.signingDomain ?? null,
        selector: r.selector ?? null,
        result: r.status?.result ?? null,
        comment: r.status?.comment ?? null,
        alignedWithAuthor: signedByAuthor(r.signingDomain, authorDomain)
    }));

    if (!signatures.length) {
        return { verified: false, reason: 'no-signature', authorDomain, signatures };
    }

    const passing = signatures.find((s) => s.result === 'pass' && s.alignedWithAuthor);
    if (passing) {
        return { verified: true, reason: 'pass', authorDomain, signatures };
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

    return { verified: false, reason, authorDomain, signatures };
}
