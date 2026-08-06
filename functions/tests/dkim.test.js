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
import { verifyEmbeddedDkim, createResolver, COVERAGE } from '../src/lib/dkim.js';

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

// Recorded as tests rather than notes because these are the facts that decide
// how most forwards behave, and they would otherwise be rediscovered as bug
// reports. The three Outlook clients do three different things, and the
// difference between them is the whole reason this module grew a second path.
test('Outlook on the web verifies on headers and seal', { skip: gated }, async () => {
    // Exchange rewrites the body -- it injects a meta tag and shifts a couple
    // of blank lines -- so `bh=` cannot match. It does not touch the headers,
    // so `b=` still holds, and Microsoft sealed a record of having verified
    // the original in full before they broke it. Neither half would be enough
    // alone: `b=` says nothing about the body, and the seal does not cover
    // `From:`.
    const result = await verifyPristine('outlook-web-attached');

    assert.equal(result.verified, true, `expected a pass, got ${result.reason}`);
    assert.equal(result.coverage, COVERAGE.headers);
    assert.equal(result.reason, 'pass-headers-sealed');
    assert.equal(result.arc.sealer, 'microsoft.com');
});

test('a Gmail forward is covered in full, not just in the headers', { skip: gated }, async () => {
    // The distinction the `coverage` field exists to carry: these words are
    // the words that were signed, where an Outlook forward's are not.
    const result = await verifyPristine('gmail-web-attached');
    assert.equal(result.coverage, COVERAGE.body);
});

test('the other Outlook clients cannot be re-verified at all', { skip: gated }, async () => {
    const expected = {
        // Rebuilds the message from its own store: the boundary is
        // regenerated, `To:` regains a display name, `Subject:` is re-encoded
        // and `Date:` is converted to UTC. All four are inside `b=`, so the
        // header signature fails too and there is nothing left to stand on.
        'outlook-desktop-attached': 'author-signature-neutral',
        // Drops the signature header from the embedded copy outright.
        'outlook-android-attached': 'no-author-signature'
    };

    for (const [name, reason] of Object.entries(expected)) {
        const result = await verifyPristine(name);
        assert.equal(result.verified, false, `${name} unexpectedly verified`);
        assert.equal(result.coverage, null);
        assert.equal(result.reason, reason, `${name} failed for a different reason`);
    }
});

// --- the seal, adversarially ------------------------------------------------
//
// The seal is only worth anything if breaking it is detectable, and the way to
// find out is to break it. Each of these rewrites the sealed record to say
// something more useful to an attacker than what Microsoft actually attested.
//
// The distinction that matters in the results: `headers-pass-but-seal-*` means
// the signature caught the edit. `headers-pass-but-sealed` would mean the seal
// still verified and we declined for some other reason -- which for a forged
// record would mean the seal was not covering what we think it covers.
const tamper = async (name, edit) => {
    const extracted = await extractOriginal(await readFile(join(privateFixtures, `${name}.eml`)));
    const text = Buffer.from(extracted.embeddedBytes).toString('latin1');
    return verifyEmbeddedDkim(
        { ...extracted, embeddedBytes: Buffer.from(edit(text), 'latin1') },
        { resolver }
    );
};

test('a forged sealed record breaks the seal', { skip: gated }, async () => {
    const edits = {
        'the attested DKIM domain': (s) =>
            s.replace(/header\.d=missionary\.org/g, 'header.d=attacker.example'),
        'the attested DMARC identity': (s) =>
            s.replace(/header\.from=missionary\.org/g, 'header.from=attacker.example'),
        'the attested DKIM verdict': (s) =>
            s.replace(/dkim=pass \(signature was verified\)/g, 'dkim=neutral (signature was verified)')
    };

    for (const [what, edit] of Object.entries(edits)) {
        const result = await tamper('outlook-web-attached', edit);
        assert.equal(result.verified, false, `${what} was accepted`);
        assert.match(result.reason, /^headers-pass-but-seal-/, `${what}: ${result.reason}`);
    }
});

test('rewriting From is caught by the header signature, not the seal', { skip: gated }, async () => {
    // The hole the header signature is there to close. ARC-Seal does not cover
    // `From:`, and Microsoft's sealed record names only the domain, so the
    // seal alone would let a genuine letter from one missionary be re-attributed
    // to another. `b=` covers `From:` exactly.
    const result = await tamper('outlook-web-attached', (s) =>
        s.replace(/^From: .*$/im, 'From: Someone Else <someone.else@missionary.org>')
    );

    assert.equal(result.verified, false);
    assert.equal(result.reason, 'author-signature-neutral');
});

test('whitespace in the sealed record is not tampering', { skip: gated }, async () => {
    // Relaxed canonicalization collapses runs of whitespace before the seal is
    // computed, so an added space changes nothing and must not be reported as
    // an attack. Recorded because the first version of the tamper test above
    // was exactly this edit, and it passing was mistaken for a hole.
    const result = await tamper('outlook-web-attached', (s) =>
        s.replace(/dkim=pass \(signature was verified\)/g, 'dkim=pass  (signature was verified) ')
    );

    assert.equal(result.verified, true, result.reason);
});
