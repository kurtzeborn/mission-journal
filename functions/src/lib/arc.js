// Reading what a forwarding provider attested, without taking its word for it.
//
// Exchange Online rewrites the body of every HTML message it stores, so an
// original forwarded out of an Outlook mailbox no longer hashes to the value
// its author signed. The signature is not wrong; the bytes are. Nine years of
// reports have not changed this, and no repair survives contact with a second
// sample -- see docs/plan.md.
//
// ARC (RFC 8617) exists for exactly this. A provider that modifies a message
// records what it saw on arrival and signs that record, so the verdict
// survives the modification that destroyed the evidence for it.
//
// Three headers per hop. Only the middle two matter here:
//
//   ARC-Authentication-Results  what the provider observed
//   ARC-Message-Signature       covers the headers *and body*, so Exchange
//                               breaks its own, exactly as it breaks DKIM's
//   ARC-Seal                    covers only the ARC headers, so it survives
//
// The seal is therefore the whole point: it is the one signature in the
// message that Exchange's body rewriting cannot invalidate, and it binds the
// authentication results to the provider that produced them.
//
// What this is emphatically not is reading `Authentication-Results`. That
// header is unsigned plain text sitting in a message a stranger forwarded us,
// and anyone can type one. The seal is the difference between evidence and a
// claim, and it is checked cryptographically here.

import { createRequire } from 'node:module';
import { parseAuthenticationResults, resultOf } from './authresults.js';

// mailauth is CommonJS and publishes no exports map, so the subpath is
// required rather than imported -- the same reason dkim.js does it.
const require = createRequire(import.meta.url);
const { verifyASChain } = require('mailauth/lib/arc');

/**
 * Whose seal is worth reading.
 *
 * Trusting a sealer means trusting it not to attest a signature it did not
 * verify, so this is a deliberately short list rather than mailauth's own
 * community trust list, which is aimed at deliverability rather than at
 * deciding who may start an archive.
 *
 * Microsoft is on it because Microsoft is the reason any of this is needed:
 * the mail it mangles is the mail this recovers. Google is not, because
 * Google's forwards verify on their own and never reach this code.
 */
export const DEFAULT_TRUSTED_SEALERS = ['microsoft.com'];

const normalizeDomain = (value) =>
    String(value ?? '').trim().toLowerCase().replace(/\.$/, '');

/** @param {string} [value] comma-separated app setting */
export function trustedSealersFrom(value) {
    const list = String(value ?? '')
        .split(',')
        .map(normalizeDomain)
        .filter(Boolean);
    return list.length ? list : [...DEFAULT_TRUSTED_SEALERS];
}

const sealerOf = (entry) => normalizeDomain(entry?.['arc-seal']?.parsed?.d?.value) || null;

// The header value opens with the instance number -- `i=2; mx.microsoft.com;
// spf=pass; ...` -- which is ARC's own bookkeeping and not a result. Left in
// place it parses as a method called `i`, and worse, it displaces the
// authserv-id so the provider that wrote the record goes unread.
const stripInstance = (value) => String(value ?? '').replace(/^\s*i\s*=\s*\d+\s*;/, '');

/**
 * What the sealed record claims, as domains rather than verdicts.
 *
 * Alignment against the author is deliberately not decided here. This module
 * knows who signed the record; whether the domains in it are the missionary's
 * is a DKIM question, and dkim.js owns it.
 */
function readSealedResults(entry) {
    const raw = entry?.['arc-authentication-results']?.original ?? '';
    // `original` is the whole header line, name included.
    const value = stripInstance(String(raw).replace(/^[^:]*:/, ''));
    const parsed = parseAuthenticationResults(value);

    const dkimDomains = parsed.results
        .filter((r) => r.method === 'dkim' && r.result === 'pass')
        .map((r) => normalizeDomain(r.properties.get('header.d')))
        .filter(Boolean);

    const dmarc = resultOf(parsed, 'dmarc');

    return {
        authservId: parsed.authservId,
        dkimDomains,
        dmarcPass: dmarc?.result === 'pass',
        dmarcFromDomain: normalizeDomain(dmarc?.properties.get('header.from')) || null
    };
}

/**
 * Verify the ARC seal chain and return what the last hop attested.
 *
 * Takes the `arc` property of a mailauth `dkimVerify` result rather than the
 * message, because the verifier has already parsed the chain out of the
 * headers and re-parsing a 200KB original to reach the same object would be
 * a second full pass for nothing.
 *
 * Only the *last* entry's results are read. An earlier hop's record is inside
 * the sealed set and equally authentic, but it describes the message at a
 * point some later hop may have altered, and the last sealer is the one whose
 * modifications we are trying to see past.
 *
 * @param {object} arcData mailauth's `{chain, lastEntry}` from dkimVerify
 * @param {object} [options]
 * @param {function} [options.resolver]
 * @param {string[]} [options.trustedSealers]
 * @returns {Promise<{sealed: boolean, sealer: string|null, reason: string, attested: object|null}>}
 */
export async function verifyArcSeal(arcData, { resolver, trustedSealers } = {}) {
    const chain = arcData?.chain;
    if (!Array.isArray(chain) || !chain.length) {
        return { sealed: false, sealer: null, reason: 'no-arc-chain', attested: null };
    }

    // `getARChain` rejects a malformed chain by storing the error rather than
    // throwing it, and a chain that did not parse must not be read at all.
    if (arcData.error) {
        return { sealed: false, sealer: null, reason: 'arc-chain-invalid', attested: null };
    }

    const lastEntry = arcData.lastEntry ?? chain[chain.length - 1];
    const sealer = sealerOf(lastEntry);

    // Checked before the seal is verified, not after. Verifying first would
    // spend a DNS lookup on any domain a forwarder cares to name, which turns
    // an inbound message into a request for arbitrary lookups.
    const trusted = (trustedSealers ?? DEFAULT_TRUSTED_SEALERS).map(normalizeDomain);
    if (!sealer || !trusted.includes(sealer)) {
        return { sealed: false, sealer, reason: 'sealer-not-trusted', attested: null };
    }

    try {
        await verifyASChain(arcData, { resolver });
    } catch (error) {
        // Includes a tampered record: editing the sealed results changes the
        // bytes the seal covers, and this is where that surfaces.
        return { sealed: false, sealer, reason: `seal-${error.code ?? 'error'}`, attested: null };
    }

    return { sealed: true, sealer, reason: 'sealed', attested: readSealedResults(lastEntry) };
}
