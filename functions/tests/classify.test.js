// Classification tests.
//
// The interesting cases here are not the happy paths. They are the ones where
// a plausible shortcut in the parser would accept a message it must not, or
// reject one it must accept. Each of those is driven by a real capture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOriginal } from '../src/lib/extract.js';
import {
    parseAuthenticationResults,
    selectAuthResults,
    resultOf,
    dmarcAligned
} from '../src/lib/authresults.js';
import { classify, CLASS, DISPOSITION } from '../src/lib/classify.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const load = async (name) => extractOriginal(await readFile(join(fixtures, `${name}.eml`)));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };

// The forward-path tests use both providers, because the captures differ in
// what they prove: the Outlook ones carry a custom forwarding domain, the
// Gmail ones a consumer mailbox. Both now agree with the Cloudflare verdict
// they were captured with.
const FORWARDER = 'scott@kurtzeborn.org';
const GMAIL_FORWARDER = 'family.example@gmail.com';

const acl = (members) => (slug) => (slug === 'elder.example' ? members : null);
const asReader = acl([{ address: FORWARDER, role: 'reader' }]);
const asOwner = acl([{ address: FORWARDER, role: 'owner' }]);
const strangersOnly = acl([{ address: 'someone.else@example.com', role: 'owner' }]);

// --- header selection ------------------------------------------------------

test('selects Cloudflare by authserv-id, not by position', async () => {
    const { headers } = await load('direct-bcc-inline-via-cloudflare');

    // The topmost Authentication-Results in every capture is mx.google.com,
    // stamped after our ingest path. A position-based reader takes that one.
    const all = headers.filter((h) => h.key === 'authentication-results');
    assert.equal(parseAuthenticationResults(all[0].value).authservId, 'mx.google.com');

    const picked = selectAuthResults(headers, 'mx.cloudflare.net');
    assert.equal(picked.authservId, 'mx.cloudflare.net');
});

test('ignores ARC-Authentication-Results despite the identical authserv-id', async () => {
    const { headers } = await load('direct-bcc-inline-via-cloudflare');

    // The ARC copy names the same provider and sits immediately above the real
    // header, so a substring match on the header name finds it first.
    const arc = headers.filter((h) => h.key === 'arc-authentication-results');
    assert.ok(arc.length > 0, 'fixture should contain ARC headers');
    const impostor = arc.find((h) => h.value.includes('mx.cloudflare.net'));
    assert.ok(impostor, 'an ARC header should name mx.cloudflare.net');

    // It also parses differently: ARC prefixes an instance tag, so the
    // identifier is in the second segment and a plain read reports none.
    assert.equal(parseAuthenticationResults(impostor.value).authservId, null);

    // Exact header-name matching is what keeps it out, not the parse result.
    const picked = selectAuthResults(headers, 'mx.cloudflare.net');
    assert.equal(picked.authservId, 'mx.cloudflare.net');
    assert.ok(!picked.results.some((r) => r.method === 'i'), 'picked an ARC header');
});

test('a header with no authserv-id matches nothing', async () => {
    const { headers } = await load('direct-bcc-inline-via-exchange');

    // Exchange Online omits the identifier and opens on spf=pass. It is
    // genuinely stamped by Microsoft and says nothing about our ingest path.
    const ar = headers.filter((h) => h.key === 'authentication-results');
    assert.ok(ar.length > 0, 'fixture should carry an Authentication-Results header');
    assert.equal(parseAuthenticationResults(ar[0].value).authservId, null);

    assert.equal(selectAuthResults(headers, 'mx.cloudflare.net'), null);
});

test('a repeated method is selected by property, not by first match', async () => {
    const { headers } = await load('direct-bcc-inline-via-cloudflare');
    const picked = selectAuthResults(headers, 'mx.cloudflare.net');

    const spfResults = picked.results.filter((r) => r.method === 'spf');
    assert.ok(spfResults.length > 1, 'fixture should carry more than one spf result');
    assert.equal(spfResults[0].result, 'none', 'first spf result should be the helo one');

    const mailfrom = resultOf(picked, 'spf', 'smtp.mailfrom');
    assert.equal(mailfrom.result, 'pass');
});

test('comments containing semicolons and colons do not split results', () => {
    const parsed = parseAuthenticationResults(
        'mx.cloudflare.net; spf=none (mx.cloudflare.net: no SPF records found; really) ' +
            'smtp.helo=mail.example.com; dmarc=pass header.from=missionary.org'
    );
    assert.equal(parsed.authservId, 'mx.cloudflare.net');
    assert.deepEqual(
        parsed.results.map((r) => `${r.method}=${r.result}`),
        ['spf=none', 'dmarc=pass']
    );
});

test('dmarc must be aligned to the domain being trusted', async () => {
    const { headers } = await load('direct-bcc-inline-via-cloudflare');
    const picked = selectAuthResults(headers, 'mx.cloudflare.net');

    assert.equal(dmarcAligned(picked, 'missionary.org').pass, true);
    // Same passing verdict, different domain: it is evidence about
    // missionary.org and about nothing else.
    assert.deepEqual(dmarcAligned(picked, 'attacker.example'), {
        pass: false,
        reason: 'dmarc-misaligned'
    });
});

// --- classification --------------------------------------------------------

test('direct send from the missionary publishes to their own slug', async () => {
    const extracted = await load('direct-bcc-inline-via-cloudflare');
    const result = classify({ extracted, headers: extracted.headers, config, lookupAcl: asOwner });

    assert.equal(result.class, CLASS.direct);
    assert.equal(result.slug, 'elder.example');
    assert.equal(result.disposition, DISPOSITION.publish);
});

test('the same message delivered via Exchange is rejected', async () => {
    // The pair differs only in the path it travelled. Nothing about the
    // message changed, so any acceptance here would come from trusting a
    // header stamped by a provider that is not ours.
    const extracted = await load('direct-bcc-inline-via-exchange');
    const result = classify({ extracted, headers: extracted.headers, config, lookupAcl: asOwner });

    assert.equal(result.class, CLASS.rejected);
    assert.equal(result.reason, 'no-auth-results');
});

test('attached forward from an ACL reader is accepted and held', async () => {
    const extracted = await load('outlook-web-attached');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: asReader,
        dkimVerified: false
    });

    assert.equal(result.class, CLASS.forward);
    assert.equal(result.slug, 'elder.example');
    assert.equal(result.disposition, DISPOSITION.hold, 'unverified original must not publish');
});

test('a re-verifying signature publishes outright', async () => {
    const extracted = await load('outlook-web-attached');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: asReader,
        dkimVerified: true
    });

    assert.equal(result.disposition, DISPOSITION.publish);
});

test('inline forward from a reader is rejected', async () => {
    // Inline text is forwarder-controlled: accepting it from a reader would
    // let them invent a letter and attribute it to the missionary.
    const extracted = await load('outlook-web-inline');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: asReader
    });

    assert.equal(result.class, CLASS.rejected);
    assert.equal(result.reason, 'inline-requires-owner');
});

test('inline forward from the owner is accepted', async () => {
    const extracted = await load('outlook-web-inline');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: asOwner
    });

    assert.equal(result.class, CLASS.forward);
    assert.equal(result.disposition, DISPOSITION.publish);
});

test('forwarder who is not on the ACL is rejected', async () => {
    const extracted = await load('outlook-web-attached');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: strangersOnly
    });

    assert.equal(result.class, CLASS.rejected);
    assert.equal(result.reason, 'forwarder-not-on-acl');
});

test('an unknown slug is rejected rather than provisioned', async () => {
    const extracted = await load('outlook-web-attached');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: () => null
    });

    assert.equal(result.class, CLASS.rejected);
    assert.equal(result.reason, 'unknown-slug');
});

test('the missionary domain is configuration, not a constant', async () => {
    const extracted = await load('direct-bcc-inline-via-cloudflare');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config: { ...config, missionaryDomains: ['example.invalid'] },
        lookupAcl: asOwner
    });

    assert.equal(result.class, CLASS.rejected);
    assert.equal(result.reason, 'author-not-missionary');
});

test('a consumer-mailbox forwarder is accepted on the same terms', async () => {
    // Same path as the Outlook captures, different provider: the alignment
    // check must not depend on the forwarder running their own domain.
    const extracted = await load('gmail-web-attached');
    const result = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: acl([{ address: GMAIL_FORWARDER, role: 'reader' }]),
        dkimVerified: true
    });

    assert.equal(result.class, CLASS.forward);
    assert.equal(result.forwarder, GMAIL_FORWARDER);
    assert.equal(result.slug, 'elder.example');
    assert.equal(result.disposition, DISPOSITION.publish);
});
