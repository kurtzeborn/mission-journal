// The ARC seal, in isolation.
//
// The parts worth testing without a message are the ones that decide whether a
// DNS lookup happens at all, and the parsing of the sealed record -- which is
// an `Authentication-Results` header with ARC's own bookkeeping bolted onto the
// front, and reading it as an ordinary one silently loses the authserv-id.
//
// The end-to-end proof that a real seal verifies, and that editing it is
// caught, lives in dkim.test.js against the pristine captures.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyArcSeal, trustedSealersFrom, DEFAULT_TRUSTED_SEALERS } from '../src/lib/arc.js';

// Any DNS call from these tests is a bug: none of them should reach the seal.
const noNetwork = async (name) => {
    throw new Error(`this test must not resolve DNS (asked for ${name})`);
};

const MICROSOFT_AAR =
    'ARC-Authentication-Results: i=2; mx.microsoft.com 1; spf=pass ' +
    'smtp.mailfrom=missionary.org; dmarc=pass (p=quarantine sp=quarantine pct=100) ' +
    'action=none header.from=missionary.org; dkim=pass (signature was verified) ' +
    'header.d=missionary.org; arc=pass (0 oda=0 ltdi=1)';

const entry = (sealerDomain, aar = MICROSOFT_AAR) => ({
    'arc-seal': { parsed: { d: { value: sealerDomain } } },
    'arc-authentication-results': { original: aar }
});

describe('who we are willing to believe', () => {
    test('an empty setting means the default', () => {
        assert.deepEqual(trustedSealersFrom(''), DEFAULT_TRUSTED_SEALERS);
        assert.deepEqual(trustedSealersFrom(undefined), DEFAULT_TRUSTED_SEALERS);
    });

    test('the default is one provider, not a general trust list', () => {
        // mailauth ships a list of forwarders that are usually honest. It is
        // much wider than anything here has a reason to trust, and none of it
        // is needed: the only provider whose seal we depend on is the one that
        // breaks the body hash in the first place.
        assert.deepEqual(DEFAULT_TRUSTED_SEALERS, ['microsoft.com']);
    });

    test('a list is split, trimmed, lowercased and stripped of trailing dots', () => {
        assert.deepEqual(trustedSealersFrom(' Microsoft.com. , google.com ,, '), [
            'microsoft.com',
            'google.com'
        ]);
    });
});

describe('the seal', () => {
    test('no chain is not a failure to verify, it is nothing to verify', async () => {
        for (const arcData of [undefined, {}, { chain: [] }]) {
            const result = await verifyArcSeal(arcData, { resolver: noNetwork });
            assert.equal(result.sealed, false);
            assert.equal(result.reason, 'no-arc-chain');
        }
    });

    test('a chain that did not parse is not read', async () => {
        // `getARChain` records a malformed chain in `error` rather than
        // throwing, so without this check the entries would be read anyway.
        const result = await verifyArcSeal(
            { chain: [entry('microsoft.com')], error: new Error('bad chain') },
            { resolver: noNetwork }
        );

        assert.equal(result.sealed, false);
        assert.equal(result.reason, 'arc-chain-invalid');
        assert.equal(result.attested, null);
    });

    test('an untrusted sealer is refused before any DNS is spent', async () => {
        // The ordering is the point. Verifying first would spend a lookup on
        // whatever domain an inbound message cares to name, which turns
        // arriving mail into a request for arbitrary DNS queries. `noNetwork`
        // throwing would fail this test.
        const result = await verifyArcSeal(
            { chain: [entry('forwarder.example')] },
            { resolver: noNetwork }
        );

        assert.equal(result.sealed, false);
        assert.equal(result.sealer, 'forwarder.example');
        assert.equal(result.reason, 'sealer-not-trusted');
    });

    test('a seal with no signing domain is refused', async () => {
        const result = await verifyArcSeal({ chain: [{}] }, { resolver: noNetwork });

        assert.equal(result.sealed, false);
        assert.equal(result.sealer, null);
        assert.equal(result.reason, 'sealer-not-trusted');
    });

    test('the trusted list is what is honored, not the default', async () => {
        const result = await verifyArcSeal(
            { chain: [entry('microsoft.com')] },
            { resolver: noNetwork, trustedSealers: ['google.com'] }
        );

        assert.equal(result.reason, 'sealer-not-trusted');
    });
});
