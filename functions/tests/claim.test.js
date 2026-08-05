// Claim and promotion tests.
//
// The claim flow is the one place where somebody with no account acquires
// access to a family's letters, so most of what follows is about refusal:
// who must not be able to claim a site, and what must still be true after a
// crash, a replay, or two people following the same link at once.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIngest } from '../src/lib/ingest.js';
import { verifyEmbeddedDkim } from '../src/lib/dkim.js';
import { memoryStore } from './memory-store.js';
import { attachClaimToken, recordClaimEmailSent, describeClaim, redeemClaim } from '../src/lib/claim.js';
import { promotePending } from '../src/lib/promote.js';
import { membershipsFor, recordMembership, rebuildMemberships } from '../src/lib/memberships.js';
import { touchSiteActivity, setSiteName } from '../src/lib/sites.js';
import { issueClaimToken } from '../src/lib/claimtoken.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };
const silent = { info() {}, warn() {}, error() {} };
const KEY = 'a-signing-key-from-key-vault';
const SLUG = 'elder.example';
const CLAIMANT = 'Parent@Example.COM';

const noNetwork = async (name) => {
    throw new Error(`unit tests must not resolve DNS (asked for ${name})`);
};
const offlineDkim = (extracted) => verifyEmbeddedDkim(extracted, { resolver: noNetwork });

const NOW = () => new Date('2026-08-03T12:00:00Z');

// The corpus has one direct fixture, and seeding it twice is not two letters:
// it is the same letter, which promotion correctly collapses to one post. This
// gives each copy its own identity so a backlog is a backlog.
function variant(bytes, n) {
    return Buffer.from(
        bytes
            .toString('utf8')
            .replace(/^Message-ID:.*$/im, `Message-ID: <letter-${n}@missionary.org>`)
            .replace(/^Subject:(.*)$/im, `Subject:$1 (week ${n})`),
        'utf8'
    );
}

// Hold one letter for a site that does not exist.
async function hold(store, ulid = '01TEST0000000000000000000', n = 0, now = NOW) {
    store.seed(ulid, variant(await raw('direct-missionary'), n));
    return runIngest({ ulid, store, config, log: silent, now, verifyDkim: offlineDkim });
}

async function pendingSite(letters = 1) {
    const store = memoryStore();
    for (let i = 0; i < letters; i++) {
        await hold(store, `01TEST000000000000000000${i}`, i);
    }
    return store;
}

const claimOf = (store) => store.json('pending', `${SLUG}/claim.json`);
const pendingLetters = (store) =>
    [...store.blobs.keys()].filter((k) => k.startsWith(`pending/${SLUG}/`) && k.endsWith('.eml'));

// --- what the claim record accumulates -------------------------------------

describe('the claim record', () => {
    test('remembers a subject line so the claim page can prove itself', async () => {
        const store = await pendingSite(1);
        const claim = claimOf(store);

        assert.equal(claim.messageCount, 1);
        assert.equal(claim.sampleSubjects.length, 1);
        assert.ok(claim.sampleSubjects[0].length > 0);
        assert.match(claim.sender, /@missionary\.org$/);
    });

    test('keeps the earliest subjects and stops at three', async () => {
        const store = await pendingSite(5);
        const claim = claimOf(store);

        assert.equal(claim.messageCount, 5);
        assert.equal(claim.sampleSubjects.length, 3, 'a stolen link must not summarise the archive');
    });

    test('starts unclaimed and with no live token', async () => {
        const claim = claimOf(await pendingSite(1));
        assert.equal(claim.claimedAt, null);
        assert.equal(claim.claimTokenHash, null);
        assert.deepEqual(claim.emailedAddresses, []);
    });
});

// --- issuing a link --------------------------------------------------------

describe('issuing a claim link', () => {
    test('stores only the hash, never the token', async () => {
        const store = await pendingSite(1);
        const issued = await attachClaimToken({ store, slug: SLUG, key: KEY, emailTo: CLAIMANT, now: NOW });
        const claim = claimOf(store);

        assert.equal(issued.status, 'issued');
        assert.ok(issued.token);
        const blobText = store.blobs.get(`pending/${SLUG}/claim.json`).bytes.toString('utf8');
        assert.ok(!blobText.includes(issued.token), 'the token must not be recoverable from storage');
        assert.equal(claim.claimTokenHash.length, 64);
    });

    test('takes its expiry from the letters it points at', async () => {
        const store = await pendingSite(1);
        const issued = await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });

        // A link that outlives the letters leads to a page that cannot help.
        assert.equal(issued.expiresAt, claimOf(store).expiresAt);
    });

    test('records who it was sent to, lowercased, and counts the sends', async () => {
        const store = await pendingSite(1);
        await recordClaimEmailSent({ store, slug: SLUG, emailTo: CLAIMANT, now: NOW });
        await recordClaimEmailSent({ store, slug: SLUG, emailTo: 'Other@Example.com', now: NOW });

        const claim = claimOf(store);
        assert.equal(claim.claimEmailCount, 2);
        assert.deepEqual(claim.emailedAddresses, ['parent@example.com', 'other@example.com']);
    });

    test('minting a token does not claim anybody was told about it', async () => {
        const store = await pendingSite(1);
        await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });

        // The purge timer deletes expired letters and shouts only when the
        // manifest says nobody was ever offered them. If minting counted as
        // offering, a send that failed would silence that alarm permanently.
        const claim = claimOf(store);
        assert.equal(claim.claimEmailCount, 0);
        assert.equal(claim.claimEmailSentAt, null);
        assert.deepEqual(claim.emailedAddresses, []);
        assert.ok(claim.claimTokenHash, 'but the token itself is recorded');
    });

    test('re-issuing invalidates the previous link', async () => {
        const store = await pendingSite(1);
        const first = await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });
        await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });

        const described = await describeClaim({ store, token: first.token, key: KEY, now: NOW });
        assert.equal(described.status, 'superseded');
    });

    test('returns nothing for a site that was never pending', async () => {
        const store = memoryStore();
        assert.equal(await attachClaimToken({ store, slug: 'nobody', key: KEY, now: NOW }), null);
    });
});

// --- the landing page ------------------------------------------------------

describe('what the claim page may show', () => {
    test('names the sender and counts the letters waiting', async () => {
        const store = await pendingSite(3);
        const { token } = await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });
        const described = await describeClaim({ store, token, key: KEY, now: NOW });

        assert.equal(described.status, 'ready');
        assert.equal(described.slug, SLUG);
        assert.equal(described.messageCount, 3);
        assert.equal(described.sampleSubjects.length, 3);
    });

    test('never discloses who the link was emailed to', async () => {
        const store = await pendingSite(1);
        const { token } = await attachClaimToken({ store, slug: SLUG, key: KEY, emailTo: CLAIMANT, now: NOW });
        const described = await describeClaim({ store, token, key: KEY, now: NOW });

        assert.equal(JSON.stringify(described).includes('example.com'), false);
        assert.equal(described.emailedAddresses, undefined);
    });

    test('a forged token discloses nothing at all', async () => {
        const store = await pendingSite(1);
        await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });
        const forged = issueClaimToken({ slug: SLUG, key: 'wrong-key', expiresAt: '2099-01-01T00:00:00Z' });

        const described = await describeClaim({ store, token: forged.token, key: KEY, now: NOW });
        assert.equal(described.status, 'invalid');
        assert.equal(described.slug, undefined);
    });

    test('an expired link still names its site, so a fresh one can be offered', async () => {
        const store = await pendingSite(1);
        const { token } = await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });

        const described = await describeClaim({
            store,
            token,
            key: KEY,
            now: () => new Date('2027-01-01T00:00:00Z')
        });
        assert.equal(described.status, 'expired');
        assert.equal(described.slug, SLUG);
    });
});

// --- redemption ------------------------------------------------------------

async function readyToClaim(letters = 2) {
    const store = await pendingSite(letters);
    const { token } = await attachClaimToken({ store, slug: SLUG, key: KEY, emailTo: CLAIMANT, now: NOW });
    return { store, token };
}

describe('redeeming a claim', () => {
    test('creates the site, the owner and the archive in one go', async () => {
        const { store, token } = await readyToClaim(2);
        const result = await redeemClaim({
            store, tables: store, token, key: KEY,
            principal: CLAIMANT, displayName: 'Elder Example', now: NOW, log: silent
        });

        assert.equal(result.status, 'ok');
        assert.equal(result.promoted.promoted, 2);

        const acl = store.json('config', `${SLUG}/acl.json`);
        assert.equal(acl.members.length, 1);
        assert.equal(acl.members[0].email, 'parent@example.com', 'ownership binds to a lowercased address');
        assert.equal(acl.members[0].role, 'owner');

        const posts = store.json('rendered', `${SLUG}/posts.json`);
        assert.equal(posts.length, 2);
    });

    test('does not mark the new owner a verified missionary', async () => {
        const { store, token } = await readyToClaim(1);
        await redeemClaim({ store, tables: store, token, key: KEY, principal: CLAIMANT, now: NOW, log: silent });

        // Following a link proves you were sent it. It does not prove you are
        // the missionary, and that flag protects against removal.
        assert.equal(store.json('config', `${SLUG}/acl.json`).members[0].verifiedMissionary, false);
    });

    test('leaves the claimant able to find their way back', async () => {
        const { store, token } = await readyToClaim(1);
        await redeemClaim({
            store, tables: store, token, key: KEY,
            principal: CLAIMANT, displayName: 'Elder Example', now: NOW, log: silent
        });

        const mine = await membershipsFor({ tables: store, email: 'PARENT@example.com' });
        assert.equal(mine.length, 1);
        assert.equal(mine[0].slug, SLUG);
        assert.equal(mine[0].role, 'owner');
        assert.equal(mine[0].missionaryDisplayName, 'Elder Example');
    });

    test('empties the pending container but keeps the record of the claim', async () => {
        const { store, token } = await readyToClaim(2);
        await redeemClaim({ store, tables: store, token, key: KEY, principal: CLAIMANT, now: NOW, log: silent });

        assert.equal(pendingLetters(store).length, 0, 'promoted letters are no longer pending');

        // The record stays. It is what makes a replayed link say "already
        // claimed" rather than silently doing nothing.
        const claim = claimOf(store);
        assert.equal(claim.claimedBy, 'parent@example.com');
        assert.equal(claim.claimedAt, '2026-08-03T12:00:00.000Z');
    });

    test('refuses a second person following the same link', async () => {
        const { store, token } = await readyToClaim(1);
        await redeemClaim({ store, tables: store, token, key: KEY, principal: CLAIMANT, now: NOW, log: silent });

        const second = await redeemClaim({
            store, tables: store, token, key: KEY,
            principal: 'stranger@example.com', now: NOW, log: silent
        });

        assert.equal(second.status, 'claimed');
        const acl = store.json('config', `${SLUG}/acl.json`);
        assert.equal(acl.members.length, 1);
        assert.equal(acl.members[0].email, 'parent@example.com');
    });

    test('lets the same person retry after a crash without doubling anything', async () => {
        const { store, token } = await readyToClaim(2);
        await redeemClaim({ store, tables: store, token, key: KEY, principal: CLAIMANT, now: NOW, log: silent });

        const again = await redeemClaim({
            store, tables: store, token, key: KEY, principal: CLAIMANT, now: NOW, log: silent
        });

        assert.equal(again.status, 'ok');
        assert.equal(store.json('rendered', `${SLUG}/posts.json`).length, 2, 'no letter published twice');
        assert.equal(store.json('config', `${SLUG}/acl.json`).members.length, 1);
    });

    test('refuses an expired link even though the letters are still there', async () => {
        const { store, token } = await readyToClaim(1);
        const result = await redeemClaim({
            store, tables: store, token, key: KEY, principal: CLAIMANT,
            now: () => new Date('2027-01-01T00:00:00Z'), log: silent
        });

        assert.equal(result.status, 'expired');
        assert.equal(store.json('config', `${SLUG}/acl.json`), null);
    });

    test('refuses a forged link', async () => {
        const { store } = await readyToClaim(1);
        const forged = issueClaimToken({ slug: SLUG, key: 'wrong-key', expiresAt: '2099-01-01T00:00:00Z' });

        const result = await redeemClaim({
            store, tables: store, token: forged.token, key: KEY, principal: CLAIMANT, now: NOW, log: silent
        });

        assert.equal(result.status, 'invalid');
        assert.equal(store.json('config', `${SLUG}/acl.json`), null);
    });

    test('refuses a superseded link', async () => {
        const { store, token } = await readyToClaim(1);
        await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });

        const result = await redeemClaim({
            store, tables: store, token, key: KEY, principal: CLAIMANT, now: NOW, log: silent
        });

        assert.equal(result.status, 'superseded');
        assert.equal(store.json('config', `${SLUG}/acl.json`), null);
    });

    test('refuses an anonymous caller holding a perfectly good link', async () => {
        const { store, token } = await readyToClaim(1);
        const result = await redeemClaim({
            store, tables: store, token, key: KEY, principal: '', now: NOW, log: silent
        });

        assert.equal(result.status, 'unauthenticated');
        assert.equal(store.json('config', `${SLUG}/acl.json`), null);
        assert.equal(pendingLetters(store).length, 1, 'nothing is published to nobody');
    });
});

// --- promotion on its own --------------------------------------------------

describe('promoting a backlog', () => {
    test('stamps the site with the newest letter it published', async () => {
        const { store, token } = await readyToClaim(3);

        await redeemClaim({
            store, tables: store, token, key: KEY,
            principal: CLAIMANT, displayName: 'Elder Example', now: NOW, log: silent
        });

        const mine = await membershipsFor({ tables: store, email: CLAIMANT });
        const posts = JSON.parse(store.blobs.get(`rendered/${SLUG}/posts.json`).bytes.toString('utf8'));
        const newest = posts.reduce((latest, post) => (post.originalDate > latest ? post.originalDate : latest), '');

        // Without this the archive would sort as though it had never received
        // anything, which is the exact bug that moving the field off the
        // membership rows was meant to end.
        assert.notEqual(mine[0].lastPostAt, '');
        assert.equal(mine[0].lastPostAt, newest);
    });

    test('a failed index write does not cost the letter', async () => {
        const { store, token } = await readyToClaim(1);
        const errors = [];

        // Tables are a sort order; letters are the product.
        store.upsertEntity = async (table) => {
            if (table === 'sites') throw new Error('table unavailable');
        };

        const result = await redeemClaim({
            store, tables: store, token, key: KEY, principal: CLAIMANT,
            now: NOW, log: { ...silent, error: (m) => errors.push(m) }
        });

        assert.equal(result.status, 'ok');
        assert.equal(result.promoted.promoted, 1);
        assert.ok(store.blobs.has(`rendered/${SLUG}/posts.json`));
        assert.ok(errors.some((m) => m.includes('site activity write failed')));
    });
    test('publishes every held letter and archives its raw copy', async () => {
        const store = await pendingSite(3);
        const result = await promotePending({ store, slug: SLUG, now: NOW, log: silent });

        assert.equal(result.promoted, 3);
        assert.equal(result.failed.length, 0);
        assert.equal(store.json('rendered', `${SLUG}/posts.json`).length, 3);

        // Each letter archives several blobs, so count the folders.
        const archived = new Set(
            [...store.blobs.keys()]
                .filter((k) => k.startsWith(`raw/${SLUG}/`))
                .map((k) => k.split('/')[2])
        );
        assert.equal(archived.size, 3);
    });

    test('queues a render for each letter, so photos are not left unextracted', async () => {
        const store = await pendingSite(3);
        await promotePending({ store, slug: SLUG, now: NOW, log: silent });

        assert.equal(store.queues.get('render').length, 3);
    });

    test('is safe to run twice', async () => {
        const store = await pendingSite(2);
        await promotePending({ store, slug: SLUG, now: NOW, log: silent });
        const second = await promotePending({ store, slug: SLUG, now: NOW, log: silent });

        assert.equal(second.promoted, 0);
        assert.equal(store.json('rendered', `${SLUG}/posts.json`).length, 2);
    });

    test('leaves a letter pending if committing it fails', async () => {
        const store = await pendingSite(2);
        const [first] = pendingLetters(store);
        const failing = first.slice('pending/'.length);

        // Fail one letter for a reason promotion cannot anticipate. Corrupting
        // the bytes would not do it -- the parser accepts almost anything and
        // would happily publish an empty post, which is its own problem but
        // not this one.
        const flaky = {
            ...store,
            async readBlob(container, name) {
                if (container === 'pending' && name === failing) throw new Error('storage said no');
                return store.readBlob(container, name);
            }
        };

        const result = await promotePending({ store: flaky, slug: SLUG, now: NOW, log: silent });

        // The other letter still published, and the broken one is still held
        // rather than deleted -- those bytes are the only copy there is.
        assert.equal(result.promoted, 1);
        assert.equal(result.failed.length, 1);
        assert.ok(store.blobs.has(first), 'a letter that failed to publish must not be discarded');
    });

    test('collapses the same letter held more than once into one post', async () => {
        // A retry at the sending end, or a message delivered twice, holds two
        // identical blobs. Promotion must not publish the letter twice.
        const store = memoryStore();
        await hold(store, '01TESTA00000000000000000A', 7);
        await hold(store, '01TESTB00000000000000000B', 7);

        const result = await promotePending({ store, slug: SLUG, now: NOW, log: silent });

        assert.equal(result.promoted, 1);
        assert.equal(result.duplicates, 1);
        assert.equal(store.json('rendered', `${SLUG}/posts.json`).length, 1);
        assert.equal(pendingLetters(store).length, 0, 'a duplicate is still cleared from pending');
    });

    test('does nothing at all for a slug with nothing held', async () => {
        const store = memoryStore();
        const result = await promotePending({ store, slug: 'nobody', now: NOW, log: silent });

        assert.deepEqual(result, { promoted: 0, duplicates: 0, failed: [], postIds: [] });
    });
});

// --- the membership index --------------------------------------------------

describe('the membership index', () => {
    test('sorts the sites someone belongs to by most recent activity', async () => {
        const store = memoryStore();
        const tables = store;
        await recordMembership({ tables, email: 'a@example.com', slug: 'quiet', role: 'reader', now: NOW });
        await recordMembership({ tables, email: 'a@example.com', slug: 'busy', role: 'reader', now: NOW });
        await recordMembership({ tables, email: 'a@example.com', slug: 'empty', role: 'reader', now: NOW });

        // Activity lives on the site, not on the membership -- so it is set
        // once per site here rather than once per person.
        await touchSiteActivity({ tables, slug: 'quiet', lastPostAt: '2026-01-01' });
        await touchSiteActivity({ tables, slug: 'busy', lastPostAt: '2026-08-01' });

        const mine = await membershipsFor({ tables, email: 'a@example.com' });
        assert.deepEqual(mine.map((m) => m.slug), ['busy', 'quiet', 'empty']);
    });

    test('shows every member the site`s current name, not the one they joined under', async () => {
        const store = memoryStore();
        const tables = store;
        await recordMembership({ tables, email: 'first@example.com', slug: SLUG, role: 'owner', now: NOW });
        await setSiteName({ tables, slug: SLUG, missionaryDisplayName: 'Elder Exmaple' });

        // A typo fixed after a second reader was added. One write, and both
        // of them see it -- which is the whole reason the name is not copied
        // onto each membership row.
        await recordMembership({ tables, email: 'second@example.com', slug: SLUG, role: 'reader', now: NOW });
        await setSiteName({ tables, slug: SLUG, missionaryDisplayName: 'Elder Example' });

        for (const who of ['first@example.com', 'second@example.com']) {
            const mine = await membershipsFor({ tables, email: who });
            assert.equal(mine[0].missionaryDisplayName, 'Elder Example');
        }
    });

    test('does not leak one person`s sites to another', async () => {
        const store = memoryStore();
        await recordMembership({ tables: store, email: 'a@example.com', slug: 'hers', role: 'owner', now: NOW });

        assert.deepEqual(await membershipsFor({ tables: store, email: 'b@example.com' }), []);
    });

    test('is rebuildable from the ACL, which is the authority', async () => {
        const store = memoryStore();
        await recordMembership({ tables: store, email: 'gone@example.com', slug: SLUG, role: 'owner', now: NOW });

        await rebuildMemberships({
            tables: store,
            slug: SLUG,
            acl: { slug: SLUG, members: [{ email: 'stays@example.com', role: 'owner' }] },
            now: NOW
        });

        // A row that outlives its ACL entry is a redirect into a 403.
        assert.deepEqual(await membershipsFor({ tables: store, email: 'gone@example.com' }), []);
        assert.equal((await membershipsFor({ tables: store, email: 'stays@example.com' }))[0].slug, SLUG);
    });
});
