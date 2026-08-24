// Ingest pipeline tests.
//
// The pipeline is driven against an in-memory store so the concurrency retry,
// the dedupe gate and the path construction can all be exercised with real
// fixture mail and no cloud.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    runIngest,
    MAX_RAW_BYTES,
    acceptedRecipient,
    recipientDomains
} from '../src/lib/ingest.js';
import { verifyEmbeddedDkim } from '../src/lib/dkim.js';
import { safeName, msgIdSegment, validSlug } from '../src/lib/paths.js';
import { memoryStore } from './memory-store.js';
import { normalizeSubject, bodyHead100, findDuplicate, dedupeKey } from '../src/lib/dedupe.js';
import { dayInOwnOffset, rfc3339InOwnOffset } from '../src/lib/dates.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };
const OWNER = [{ email: 'scott@kurtzeborn.org', role: 'owner' }];
const READER = [{ email: 'scott@kurtzeborn.org', role: 'reader' }];

const silent = { info() {}, warn() {}, error() {} };

// These fixtures are scrubbed, so their body hashes cannot match the
// signatures they still carry and DKIM verification stops before it would
// look up a key. That makes the suite hermetic today -- but by accident, not
// by design. This resolver turns any future accidental network call into a
// loud failure instead of a slow, flaky, offline-hostile test.
const noNetwork = async (name) => {
    throw new Error(`unit tests must not resolve DNS (asked for ${name})`);
};
const offlineDkim = (extracted) => verifyEmbeddedDkim(extracted, { resolver: noNetwork });

async function ingestFixture(store, name, ulid = '01TEST0000000000000000000') {
    store.seed(ulid, await raw(name));
    return runIngest({
        ulid,
        store,
        config,
        log: silent,
        now: () => new Date('2026-08-03T12:00:00Z'),
        verifyDkim: offlineDkim
    });
}

// --- normalization ---------------------------------------------------------

test('subject normalization strips stacked reply and tag prefixes', () => {
    assert.equal(normalizeSubject('Re: [EXTERNAL] Fwd:  Week   34'), 'week 34');
    assert.equal(normalizeSubject('FW: Re: Fwd: P-day'), 'pday');
    assert.equal(normalizeSubject(''), '');
    assert.equal(normalizeSubject(null), '');
});

test('a subject retyped with different punctuation is the same subject', () => {
    // The letter that arrived twice: the same subject, one extra exclamation
    // mark, and every other dedupe field identical.
    assert.equal(
        normalizeSubject('Zone conference week!!'),
        normalizeSubject('Zone conference week!')
    );
    assert.equal(normalizeSubject("Mother's day"), 'mothers day');
    assert.equal(normalizeSubject('Week 34 -- Ghana'), 'week 34 ghana');
});

test('body head drops quoted lines and signature blocks', () => {
    const body = ['Hello from Brazil!', '> you wrote this', '-- ', 'Elder Example'].join('\n');
    assert.equal(bodyHead100(body), 'hello from brazil!');

    const mobile = 'Short note\n\nSent from my iPhone';
    assert.equal(bodyHead100(mobile), 'short note');
});

test('the calendar day is read in the offset the header carries, not UTC', () => {
    // 22:30 on the 6th at -04:00 is already the 7th in UTC. The letter is
    // from the 6th.
    assert.equal(dayInOwnOffset('Mon, 6 Jul 2020 22:30:00 -0400'), '2020-07-06');
    assert.equal(rfc3339InOwnOffset('Mon, 6 Jul 2020 22:30:00 -0400'), '2020-07-06T22:30:00-04:00');
});

test('a client-rendered date with no offset becomes floating local time', () => {
    assert.equal(dayInOwnOffset('Sat, Aug 1, 2026 at 8:20 PM'), '2026-08-01');
    assert.equal(rfc3339InOwnOffset('Sat, Aug 1, 2026 at 8:20 PM'), '2026-08-01T20:20:00');
});

// --- path safety -----------------------------------------------------------

test('attachment names cannot escape their prefix', () => {
    assert.equal(
        safeName('../../rendered/elder.example/posts.json'),
        '-.-rendered-elder.example-posts.json'
    );
    assert.ok(!safeName('../../evil.json').includes('/'));
    assert.ok(!safeName('....//evil.json').includes('..'));
    assert.equal(safeName('.hidden'), 'hidden');
    assert.equal(safeName(''), 'unnamed');
    assert.equal(safeName(null), 'unnamed');
});

test('a long attachment name keeps its extension', () => {
    const name = safeName(`${'a'.repeat(300)}.jpg`);
    assert.ok(name.length <= 100);
    assert.ok(name.endsWith('.jpg'));
});

test('message ids are hashed, never sanitized into each other', () => {
    // Sanitizing these two would collapse them onto one directory and silently
    // merge two different letters.
    const a = msgIdSegment('<a/b@example.com>', 'U1');
    const b = msgIdSegment('<a..b@example.com>', 'U1');
    assert.notEqual(a, b);
    assert.match(a, /^m_[0-9a-f]{16}$/);
    assert.equal(msgIdSegment(null, 'U1'), 'u_U1');
});

test('slugs that could reach outside their container are refused', () => {
    assert.equal(validSlug('elder.example'), 'elder.example');
    assert.equal(validSlug('Elder.Example'), 'elder.example');
    assert.equal(validSlug('../config'), null);
    assert.equal(validSlug('a/b'), null);
    assert.equal(validSlug(''), null);
});

// --- pipeline --------------------------------------------------------------

test('a direct message becomes a post, an archive and a render job', async () => {
    const store = memoryStore();
    // The site has to exist. A direct send naming a slug with no ACL is held
    // as pending rather than published -- see the pending suite below.
    store.acl('elder.example', OWNER);
    const result = await ingestFixture(store, 'direct-missionary');

    assert.equal(result.status, 'stored');
    assert.equal(result.slug, 'elder.example');

    const posts = store.json('rendered', 'elder.example/posts.json');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].extractionSource, null);
    assert.equal(posts[0].hidden, false);
    assert.ok(posts[0].originalDate, 'the post should carry the original date');
    assert.equal(posts[0].sourceRawPath, `raw/elder.example/${result.msgId}/message.eml`);

    assert.ok(store.blobs.has(`raw/elder.example/${result.msgId}/message.eml`));
    const metadata = store.json('raw', `elder.example/${result.msgId}/metadata.json`);
    assert.equal(metadata.envelope.to, 'post@pdayletters.com');
    assert.ok(metadata.headers.some((h) => h.key === 'authentication-results'));

    assert.deepEqual(store.queues.get('render'), [
        JSON.stringify({ slug: 'elder.example', msgId: result.msgId, postId: posts[0].id })
    ]);
});

test('the post body survives extraction', async () => {
    const store = memoryStore();
    store.acl('elder.example', OWNER);
    const result = await ingestFixture(store, 'direct-missionary');
    const post = store.json('rendered', 'elder.example/posts.json')[0];
    assert.ok(post.bodyHtml || post.bodyText, 'a post with no body is not a letter');
    assert.ok(post.bodyHead100.length > 0);
    assert.equal(result.post.bodyHead100, post.bodyHead100);
});

test('the same message ingested twice yields one post', async () => {
    const store = memoryStore();
    store.acl('elder.example', OWNER);
    const first = await ingestFixture(store, 'direct-missionary', '01FIRST000000000000000000');
    const second = await ingestFixture(store, 'direct-missionary', '01SECOND00000000000000000');

    assert.equal(first.status, 'stored');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.reason, 'message-id');
    assert.equal(store.json('rendered', 'elder.example/posts.json').length, 1);
});

test('an attached forward from an ACL member is archived with its attachments', async () => {
    const store = memoryStore();
    store.acl('elder.example', READER);
    const result = await ingestFixture(store, 'outlook-web-attached');

    assert.equal(result.status, 'stored');
    assert.equal(result.verdict.class, 'forward');
    assert.equal(result.post.forwardedBy, 'scott@kurtzeborn.org');

    const metadata = store.json('raw', `elder.example/${result.msgId}/metadata.json`);
    for (const attachment of metadata.attachments) {
        assert.ok(!attachment.path.includes('..'));
        assert.match(attachment.path, /^attachments\/\d{2}-/);
        assert.ok(store.blobs.has(`raw/elder.example/${result.msgId}/${attachment.path}`));
    }
});

test('an unverified forward from a member is published, not held', async () => {
    const store = memoryStore();
    store.acl('elder.example', READER);
    const result = await ingestFixture(store, 'outlook-web-attached');

    // Held originally, and the hold was the wrong trade: the client that
    // cannot produce a verifiable forward is the one most of these families
    // use, so the rule hid nearly every letter from nearly everybody. The
    // invitation is the control now. Bootstrap still requires the signature.
    assert.equal(result.post.hidden, false);
    assert.equal(result.post.heldReason, null);
});

test('a forward from someone not on the ACL is rejected and nothing is written', async () => {
    const store = memoryStore();
    store.acl('elder.example', [{ email: 'stranger@example.com', role: 'owner' }]);
    const result = await ingestFixture(store, 'outlook-web-attached');

    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'forwarder-not-on-acl');
    assert.equal(store.json('rendered', 'elder.example/posts.json'), null);
    assert.equal(store.queues.get('render'), undefined);
});

test('an inline forward is stored for owner and reader alike', async () => {
    const asOwner = memoryStore();
    asOwner.acl('elder.example', OWNER);
    assert.equal((await ingestFixture(asOwner, 'outlook-web-inline')).status, 'stored');

    const asReader = memoryStore();
    asReader.acl('elder.example', READER);
    assert.equal((await ingestFixture(asReader, 'outlook-web-inline')).status, 'stored');
});

// The bytes infra/seed-config.ps1 actually uploads, checked in verbatim. Every
// other test builds its ACL through a helper, so a helper that agreed with the
// code and disagreed with the file would keep the suite green while every real
// forward was rejected as `unknown-slug`. That is exactly what happened.
test('the ACL that seed-config.ps1 writes is the ACL the classifier reads', async () => {
    const seeded = await readFile(
        join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acl.seeded.json')
    );
    const store = memoryStore();
    store.blobs.set('config/elder.example/acl.json', {
        bytes: seeded,
        metadata: {},
        etag: 'etag-seeded'
    });

    const result = await ingestFixture(store, 'outlook-web-inline');
    assert.equal(result.status, 'stored');
});

test('a lost write race is retried, not lost', async () => {
    const store = memoryStore();
    store.acl('elder.example', OWNER);
    store.conflictOnce = 'rendered/elder.example/posts.json';
    const result = await ingestFixture(store, 'direct-missionary');

    assert.equal(result.status, 'stored');
    assert.equal(store.json('rendered', 'elder.example/posts.json').length, 1);
});

test('a queue message whose blob has expired is not a failure', async () => {
    const store = memoryStore();
    const result = await runIngest({ ulid: '01GONE', store, config, log: silent });
    assert.equal(result.status, 'missing');
});

// --- pending sites ---------------------------------------------------------
//
// A missionary who BCCs post@ before anyone has set up their site. Before
// this existed the letter published to a slug with no ACL: stored, rendered,
// readable by nobody, and reported to nobody.

describe('a direct send naming a site that does not exist', () => {
    const held = async (store, ulid) => ingestFixture(store, 'direct-missionary', ulid);

    test('is held rather than published to a site nobody can read', async () => {
        const store = memoryStore();
        const result = await held(store);

        assert.equal(result.status, 'pending');
        assert.equal(result.slug, 'elder.example');

        // The letter itself is kept.
        assert.ok(
            store.blobs.has('pending/elder.example/01TEST0000000000000000000.eml'),
            'the raw message must survive'
        );

        // And nothing is published, rendered or queued.
        assert.equal(store.json('rendered', 'elder.example/posts.json'), null);
        assert.equal(store.queues.get('render'), undefined);
        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('raw/')),
            false,
            'raw/ is for claimed sites only'
        );
    });

    test('records a rolling sixty-day window, because the missionary wrote to us', async () => {
        const store = memoryStore();
        await held(store);

        const claim = store.json('pending', 'elder.example/claim.json');
        assert.equal(claim.slug, 'elder.example');
        assert.equal(claim.hasDirect, true);
        assert.equal(claim.messageCount, 1);
        assert.equal(claim.createdAt, '2026-08-03T12:00:00.000Z');
        assert.equal(claim.expiresAt, '2026-10-02T12:00:00.000Z');
    });

    // The address recorded here is the one the claim link gets emailed to, so
    // it is a credential-routing decision wearing the clothes of a metadata
    // field. A missionary quoting a message from home writes a line beginning
    // `From:`, which is indistinguishable from the header block a mail client
    // leaves behind when it flattens a forward -- and the extractor, whose
    // whole job is to see past a forward, duly reports the quoted address.
    test('a quoted From: line in the body cannot redirect the claim link', async () => {
        const store = memoryStore();
        const letter = [
            'Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=missionary.org',
            'From: Elder Example <elder.example@missionary.org>',
            'To: post@pdayletters.com',
            'Subject: Week 14',
            'Message-ID: <week14@missionary.org>',
            'Date: Sat, 1 Aug 2026 19:45:32 -0700',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Mum sent me this and I thought you would all like it:',
            '',
            'From: Mum <mum@example.com>',
            'Subject: the dog',
            '',
            'The dog is fine.',
            ''
        ].join('\r\n');

        store.seed('01TEST0000000000000000000', Buffer.from(letter, 'utf8'));
        const result = await runIngest({
            ulid: '01TEST0000000000000000000',
            store,
            config,
            log: silent,
            now: () => new Date('2026-08-03T12:00:00Z'),
            verifyDkim: offlineDkim
        });

        assert.equal(result.status, 'pending');
        assert.equal(result.slug, 'elder.example');

        const claim = store.json('pending', 'elder.example/claim.json');
        assert.equal(
            claim.sender,
            'elder.example@missionary.org',
            'the authenticated sender writes the letter, not a line in its body'
        );
    });

    test('a second letter extends the window instead of starting a second site', async () => {
        const store = memoryStore();
        await held(store, '01FIRST000000000000000000');
        await held(store, '01SECOND00000000000000000');

        const claim = store.json('pending', 'elder.example/claim.json');
        assert.equal(claim.messageCount, 2);
        assert.equal(claim.createdAt, '2026-08-03T12:00:00.000Z');
        assert.ok(store.blobs.has('pending/elder.example/01FIRST000000000000000000.eml'));
        assert.ok(store.blobs.has('pending/elder.example/01SECOND00000000000000000.eml'));
    });

    test('two letters racing each other do not lose the manifest', async () => {
        const store = memoryStore();
        store.conflictOnce = 'pending/elder.example/claim.json';
        await held(store);

        assert.equal(store.json('pending', 'elder.example/claim.json').messageCount, 1);
    });

    test('once the site exists the same letter publishes normally', async () => {
        const store = memoryStore();
        store.acl('elder.example', OWNER);
        const result = await held(store);

        assert.equal(result.status, 'stored');
        assert.equal(store.json('pending', 'elder.example/claim.json'), null);
    });
});

// --- bootstrapping from a forward ------------------------------------------
//
// The flow the plan calls the one we advertise, and which had been dead since
// Phase 6: a parent forwards the first letter home before any site exists, and
// is offered the site. Phase 6 rejected it because there was no claim email
// yet to tell anybody anything had happened -- a reason that stopped applying
// the moment Phase 7 shipped one, and which nobody revisited.
//
// These tests need DKIM to *pass*, which the offline stub never does, so the
// verifier is replaced outright. That is the honest thing to stub here: the
// question this path turns on is "did the embedded original re-verify", and
// re-verifying it for real needs DNS.
describe('a forward naming a site that does not exist', () => {
    const verified = async () => ({ verified: true, reason: null, signatures: [] });

    const bootstrap = async (store, { mailer, name = 'outlook-web-attached' } = {}) => {
        store.seed('01TEST0000000000000000000', await raw(name));
        return runIngest({
            ulid: '01TEST0000000000000000000',
            store,
            mailer,
            config: { ...config, claimTokenKey: 'a-signing-key', baseUrl: 'https://pdayletters.com' },
            log: silent,
            now: () => new Date('2026-08-03T12:00:00Z'),
            verifyDkim: verified
        });
    };

    test('is held rather than rejected, now that there is a way to tell anyone', async () => {
        const store = memoryStore();
        const result = await bootstrap(store);

        assert.equal(result.status, 'pending');
        assert.equal(result.slug, 'elder.example');
        assert.ok(store.json('pending', 'elder.example/claim.json'), 'no pending site was created');
        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('raw/')),
            false,
            'a forward published to a site with no ACL'
        );
    });

    test('takes the shorter window, because the missionary never wrote to us', async () => {
        const store = memoryStore();
        await bootstrap(store);

        const claim = store.json('pending', 'elder.example/claim.json');
        assert.equal(claim.hasDirect, false);
        // `PENDING_DAYS.forwardOnly` has existed in pending.js since Phase 6
        // and has been unreachable that whole time.
        assert.notEqual(claim.expiresAt, '2026-10-02T12:00:00.000Z');
    });

    test('offers the site to the forwarder, not the missionary', async () => {
        // Mailing the missionary here would interrupt someone who asked for
        // nothing, which is the entire thing this flow exists to avoid.
        const store = memoryStore();
        const mailer = { sent: [], send: async (m) => (mailer.sent.push(m), { status: 'sent' }) };
        await bootstrap(store, { mailer });

        assert.equal(mailer.sent.length, 1);
        assert.notEqual(mailer.sent[0].to, 'elder.example@missionary.org');
        assert.match(mailer.sent[0].text, /you forwarded/i);
    });

    test('records the missionary as the sender even though a parent sent it', async () => {
        // The claim page shows this so a recipient can tell whose archive they
        // are being offered, and the answer is the author's, not their own.
        const store = memoryStore();
        await bootstrap(store);

        assert.equal(
            store.json('pending', 'elder.example/claim.json').sender,
            'elder.example@missionary.org'
        );
    });

    test('an unverifiable forward is still rejected', async () => {
        const store = memoryStore();
        store.seed('01TEST0000000000000000000', await raw('outlook-web-attached'));
        const result = await runIngest({
            ulid: '01TEST0000000000000000000',
            store,
            config,
            log: silent,
            now: () => new Date('2026-08-03T12:00:00Z'),
            verifyDkim: offlineDkim
        });

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'bootstrap-unverified');
        assert.equal(store.json('pending', 'elder.example/claim.json'), null);
    });
});

test('an oversized message is refused before the parser sees it', async () => {
    const store = memoryStore();
    store.seed('01BIG', Buffer.alloc(MAX_RAW_BYTES + 1));
    const result = await runIngest({ ulid: '01BIG', store, config, log: silent });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'oversize');
});

// --- accepted recipient domains --------------------------------------------
//
// Defense in depth behind Cloudflare's routing. The tests that matter most
// here are the ones asserting it stays out of the way: this check guards
// against a hypothetical second domain, and it sits in front of every real
// letter, so being wrong in the cautious direction costs mail.

describe('accepted recipient domains', () => {
    const accepting = { ...config, acceptedIngestDomains: ['pdayletters.com'] };

    test('an unset list accepts everything, so a missing setting cannot start rejecting', () => {
        assert.equal(acceptedRecipient('anyone@wherever.test', []), true);
        assert.equal(acceptedRecipient('anyone@wherever.test', undefined), true);
    });

    test('an unreadable recipient is accepted rather than dropped', () => {
        // Losing a real letter over a metadata field is far worse than
        // publishing one from an unexpected domain, which is visible and
        // reversible.
        assert.equal(acceptedRecipient(null, ['pdayletters.com']), true);
        assert.equal(acceptedRecipient('', ['pdayletters.com']), true);
        assert.equal(acceptedRecipient('not-an-address', ['pdayletters.com']), true);
    });

    test('a listed domain is accepted whatever the mailbox or case', () => {
        assert.equal(acceptedRecipient('post@pdayletters.com', ['pdayletters.com']), true);
        assert.equal(acceptedRecipient('probe@PDayLetters.com', ['pdayletters.com']), true);
    });

    test('an unlisted domain is refused, including a lookalike suffix', () => {
        assert.equal(acceptedRecipient('post@example.com', ['pdayletters.com']), false);
        assert.equal(acceptedRecipient('post@evilpdayletters.com', ['pdayletters.com']), false);
        assert.equal(acceptedRecipient('post@pdayletters.com.evil.test', ['pdayletters.com']), false);
    });

    test('one listed recipient among several is enough', () => {
        const to = 'someone@example.com, post@pdayletters.com';
        assert.equal(acceptedRecipient(to, ['pdayletters.com']), true);
        assert.deepEqual(recipientDomains(to), ['example.com', 'pdayletters.com']);
    });

    test('a real letter to the configured domain still ingests', async () => {
        const store = memoryStore();
        store.acl('elder.example', READER);
        store.seed('01OK', await raw('outlook-web-attached'), { to: 'post@pdayletters.com' });

        const result = await runIngest({
            ulid: '01OK',
            store,
            config: accepting,
            log: silent,
            now: () => new Date('2026-08-03T12:00:00Z'),
            verifyDkim: offlineDkim
        });

        assert.equal(result.status, 'stored');
    });

    test('a letter addressed to another domain is refused before it is parsed', async () => {
        const store = memoryStore();
        store.acl('elder.example', READER);
        store.seed('01BAD', await raw('outlook-web-attached'), { to: 'post@somewhere-else.test' });

        const result = await runIngest({
            ulid: '01BAD',
            store,
            config: accepting,
            log: silent,
            now: () => new Date('2026-08-03T12:00:00Z'),
            verifyDkim: offlineDkim
        });

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'recipient-domain');
        // Nothing written and nothing queued: a refused message must not leave
        // a partial trace behind.
        assert.equal(store.json('rendered', 'elder.example/posts.json'), null);
        assert.equal(store.queues.get('render'), undefined);
    });
});

// --- dedupe gate -----------------------------------------------------------

test('an empty normalized field never matches another empty one', () => {
    // Two unrelated photo-only forwards from one relative on one day. Gmail
    // composes an attached forward with an empty subject unless the forwarder
    // types one, so both normalize to empty strings.
    const key = dedupeKey({
        messageId: null,
        from: 'elder.example@missionary.org',
        dateHeader: 'Sat, 1 Aug 2026 20:20:00 -0700',
        subject: '',
        text: ''
    });
    const existing = [{
        id: 'other',
        originalMessageId: null,
        originalFrom: 'elder.example@missionary.org',
        originalDate: '2026-08-01T20:20:00-07:00',
        subject: '',
        bodyHead100: ''
    }];
    assert.equal(findDuplicate(key, existing), null);
});

test('the text gate needs author, day, subject and body to all agree', () => {
    const base = {
        messageId: null,
        from: 'elder.example@missionary.org',
        dateHeader: 'Sat, 1 Aug 2026 20:20:00 -0700',
        subject: 'Week 34',
        text: 'We fixed a bike chain today.'
    };
    const existing = [{
        id: 'p1',
        originalMessageId: null,
        originalFrom: 'Elder.Example@missionary.org',
        originalDate: '2026-08-01T20:20:59-07:00',
        subject: 'Fwd: Week 34',
        bodyHead100: bodyHead100(base.text)
    }];

    assert.equal(findDuplicate(dedupeKey(base), existing).reason, 'text-match');

    // A different day is a different letter, even with everything else equal.
    const nextDay = { ...base, dateHeader: 'Sun, 2 Aug 2026 20:20:00 -0700' };
    assert.equal(findDuplicate(dedupeKey(nextDay), existing), null);

    const otherBody = { ...base, text: 'We taught a lesson today.' };
    assert.equal(findDuplicate(dedupeKey(otherBody), existing), null);
});

test('a resend with an extra exclamation mark is still the same letter', () => {
    // Sent twice, the second time with smaller photographs, and the subject
    // retyped. Nothing but the punctuation told the two copies apart.
    const resend = dedupeKey({
        messageId: null,
        from: 'elder.example@missionary.org',
        dateHeader: 'Mon, 4 May 2026 11:36:00 -0700',
        subject: 'Zone conference week!!',
        text: 'Shalom shalom, this week was a lot better than last.'
    });
    const existing = [{
        id: 'p1',
        originalMessageId: null,
        originalFrom: 'elder.example@missionary.org',
        originalDate: '2026-05-04T11:43:00-07:00',
        subject: 'Zone conference week!',
        bodyHead100: bodyHead100('Shalom shalom, this week was a lot better than last.')
    }];

    assert.equal(findDuplicate(resend, existing).reason, 'text-match');
});

