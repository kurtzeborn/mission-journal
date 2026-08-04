// DKIM re-verification tests.
//
// Split in two because the two halves can only be proven by different means.
// The public fixtures are scrubbed, so their body hashes cannot match the
// signatures they still carry -- they can prove the failure paths and the
// alignment rule, and they can never produce a pass. Proving a pass requires
// a byte-exact capture, which only exists in the private repo, and checking
// one requires a DNS lookup for the signing key. Those tests are gated and
// skip when the captures are not present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOriginal } from '../src/lib/extract.js';
import { verifyEmbeddedDkim, createResolver } from '../src/lib/dkim.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');

// Any DNS call from the ungated tests is a bug, so it is made to fail loudly
// rather than quietly turning the suite into a network-dependent one.
const noNetwork = async (name) => {
    throw new Error(`this test must not resolve DNS (asked for ${name})`);
};

const verify = async (name, options) =>
    verifyEmbeddedDkim(await extractOriginal(await readFile(join(fixtures, `${name}.eml`))), options);

// --- what can be proven without the network --------------------------------

test('an inline forward has no signature to re-verify', async () => {
    // Not a failure of verification -- there is simply nothing signed. Inline
    // text is owner-only for exactly this reason.
    const result = await verify('outlook-web-inline', { resolver: noNetwork });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'no-embedded-original');
    assert.deepEqual(result.signatures, []);
});

test('an altered body fails before any key is fetched', async () => {
    // These fixtures were scrubbed, so the body no longer hashes to what the
    // signature covers. That is the correct answer for a tampered message,
    // and it is reached without a DNS round trip.
    const result = await verify('outlook-web-attached', { resolver: noNetwork });
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'author-signature-neutral');
    assert.equal(result.signatures.length, 1);
    assert.equal(result.signatures[0].domain, 'missionary.org');
    assert.equal(result.signatures[0].alignedWithAuthor, true);
});

// --- what requires the pristine captures -----------------------------------

const privateFixtures =
    process.env.MISSION_JOURNAL_PRIVATE_FIXTURES ??
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mission-journal-private', 'fixtures');

const gated = existsSync(privateFixtures)
    ? false
    : `pristine captures not present at ${privateFixtures}`;

// Public DNS by default: these tests are opt-in already, and a local resolver
// that refuses outbound queries reports `temperror`, which is indistinguishable
// from a signing key that has been withdrawn.
const resolver = createResolver((process.env.DKIM_DNS_SERVERS ?? '1.1.1.1,8.8.8.8').split(','));

const verifyPristine = async (name) =>
    verifyEmbeddedDkim(await extractOriginal(await readFile(join(privateFixtures, `${name}.eml`))), {
        resolver
    });

test('a Gmail forward-as-attachment re-verifies against live DNS', { skip: gated }, async () => {
    const result = await verifyPristine('gmail-web-attached');
    assert.equal(result.verified, true, `expected a pass, got ${result.reason}`);
    assert.equal(result.authorDomain, 'missionary.org');
});

test('a forwarder\'s own valid signature does not count as the author\'s', { skip: gated }, async () => {
    // The load-bearing test. This capture carries three passing signatures and
    // only one of them is the missionary's; the other two belong to mail
    // systems the message merely travelled through. If alignment were dropped,
    // anyone whose provider signs outbound mail could publish as a missionary.
    const result = await verifyPristine('gmail-web-attached');

    const passing = result.signatures.filter((s) => s.result === 'pass');
    assert.ok(passing.length > 1, 'fixture no longer exercises the alignment rule');

    const strangers = passing.filter((s) => !s.alignedWithAuthor);
    assert.ok(strangers.length > 0, 'fixture no longer carries a third-party signature');
    for (const s of strangers) {
        assert.notEqual(s.domain, 'missionary.org');
    }
});

// Recorded as a test rather than a note because it is the single fact that
// decides how most forwards will behave, and it would otherwise be rediscovered
// as a bug report. Only Gmail's forward-as-attachment preserves a verifiable
// signature; every Outlook client damages or drops it, so those forwards are
// held for the owner unless the owner sent them.
test('Outlook forwards cannot be re-verified, by client', { skip: gated }, async () => {
    const expected = {
        // Re-encodes the embedded body, so the hash no longer matches.
        'outlook-web-attached': 'author-signature-neutral',
        'outlook-desktop-attached': 'author-signature-neutral',
        // Drops the signature header from the embedded copy outright.
        'outlook-android-attached': 'no-author-signature'
    };

    for (const [name, reason] of Object.entries(expected)) {
        const result = await verifyPristine(name);
        assert.equal(result.verified, false, `${name} unexpectedly verified`);
        assert.equal(result.reason, reason, `${name} failed for a different reason`);
    }
});
