// Owner edits: what may change, what changing it implies, and how the write
// behaves when a second owner is saving at the same moment.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { applyEdit, commitPosts } from '../src/lib/edit.js';

const SLUG = 'isaac.backman';
const EDITOR = 'scott@kurtzeborn.org';
const PHOTO = `/api/photo/${SLUG}/p_0eade5b54243/large.webp`;

const post = (overrides = {}) => ({
    id: '2025-11-10-ZHCM',
    originalDate: '2025-11-10T05:57:00',
    subject: 'Week one',
    bodyHtml: `<p>hello</p><img src="${PHOTO}" alt="" />`,
    bodyHead100: 'hello',
    originalFrom: 'isaac.backman@missionary.org',
    originalMessageId: null,
    hidden: false,
    ...overrides
});

const edit = (changes, target = post()) => applyEdit(target, changes, { editor: EDITOR, slug: SLUG });

describe('what an owner may change', () => {
    test('a field outside the allowlist is refused by name', () => {
        const result = edit({ originalFrom: 'someone@else.com' });
        assert.match(result.error, /not editable: originalFrom/);
    });

    test('the dedup fields are all refused, so a re-forward still matches', () => {
        for (const field of ['originalFrom', 'originalDate', 'originalMessageId', 'bodyHead100']) {
            assert.ok(edit({ [field]: 'x' }).error, `${field} must not be editable`);
        }
    });

    test('an empty body is refused rather than treated as a no-op', () => {
        assert.match(edit({}).error, /no changes/);
    });

    test('types are checked', () => {
        assert.match(edit({ hidden: 'yes' }).error, /hidden must be a boolean/);
        assert.match(edit({ subject: 42 }).error, /subject must be a string/);
        assert.match(edit({ bodyHtml: null }).error, /bodyHtml must be a string/);
    });

    test('an absurd subject is refused', () => {
        assert.match(edit({ subject: 'x'.repeat(501) }).error, /exceeds 500/);
    });
});

describe('what an edit records', () => {
    test('a subject change stamps the editor and the time', () => {
        const { post: next, changed } = edit({ subject: 'Week one, corrected' });
        assert.deepEqual(changed, ['subject']);
        assert.equal(next.editedBy, EDITOR);
        assert.ok(Date.parse(next.editedAt));
    });

    test('hiding is not an edit, so it leaves no editedBy behind', () => {
        const { post: next, changed } = edit({ hidden: true });
        assert.deepEqual(changed, ['hidden']);
        assert.equal(next.hidden, true);
        assert.equal(next.editedBy, undefined);
        assert.equal(next.editedAt, undefined);
    });

    test('setting a field to what it already was changes nothing', () => {
        const { changed } = edit({ subject: 'Week one', hidden: false });
        assert.deepEqual(changed, []);
    });
});

describe('an edited body goes through the sanitizer', () => {
    test('a script tag pasted by a hijacked session does not reach readers', () => {
        const { post: next } = edit({ bodyHtml: '<p>hi</p><script>alert(1)</script>' });
        assert.ok(!next.bodyHtml.includes('<script'));
        assert.ok(!next.bodyHtml.includes('alert(1)'));
    });

    test('an event handler attribute is stripped', () => {
        const { post: next } = edit({ bodyHtml: '<p onclick="steal()">hi</p>' });
        assert.ok(!next.bodyHtml.includes('onclick'));
    });

    // The regression this whole option exists for. The stored body has already
    // been sanitized once, so its photos are /api/photo/ URLs rather than the
    // cid: references ingest saw. Re-sanitizing without allowing for that
    // stripped their src and then dropped the elements outright -- fixing one
    // typo silently deleted every picture in the letter.
    test('photos already in the letter survive being edited around', () => {
        const { post: next } = edit({
            bodyHtml: `<p>hello there</p><img src="${PHOTO}" alt="" />`
        });
        assert.ok(next.bodyHtml.includes(PHOTO), next.bodyHtml);
    });

    test('a photo belonging to another site is still stripped', () => {
        const foreign = '/api/photo/someone.else/p_0eade5b54243/large.webp';
        const { post: next } = edit({ bodyHtml: `<p>hi</p><img src="${foreign}" alt="" />` });
        assert.ok(!next.bodyHtml.includes(foreign), next.bodyHtml);
    });

    test('a remote tracking pixel is still stripped', () => {
        const { post: next } = edit({
            bodyHtml: '<p>hi</p><img src="https://tracker.example/x.gif" alt="" />'
        });
        assert.ok(!next.bodyHtml.includes('tracker.example'));
    });

    // Readers receive bodyText, so an owner removing a name from the body
    // would otherwise publish it anyway out of a field they were never shown.
    test('editing the body drops the stale plain-text copy', () => {
        const target = post({ bodyText: 'hello, from Sister Whoever at 12 Elm Street' });
        const { post: next, changed } = edit({ bodyHtml: '<p>hello</p>' }, target);
        assert.equal(next.bodyText, undefined);
        assert.ok(changed.includes('bodyText'));
    });
});

describe('committing the change', () => {
    const seeded = () => {
        const store = memoryStore();
        store.blobs.set(`rendered/${SLUG}/posts.json`, {
            bytes: Buffer.from(JSON.stringify([post()], null, 2)),
            etag: 'e1'
        });
        return store;
    };

    const hide = (posts) => ({
        posts: posts.map((p) => ({ ...p, hidden: true }))
    });

    test('the write is guarded by the ETag that was read', async () => {
        const store = seeded();
        let seen = null;
        const original = store.writeBlob.bind(store);
        store.writeBlob = async (container, name, bytes, options) => {
            seen = options.ifMatch;
            return original(container, name, bytes, options);
        };

        await commitPosts({ store, slug: SLUG, mutate: hide, log: { info() {} } });
        assert.equal(seen, 'e1');
        assert.equal(store.json('rendered', `${SLUG}/posts.json`)[0].hidden, true);
    });

    test('a lost race is retried against what the winner left behind', async () => {
        const store = seeded();
        store.conflictOnce = `rendered/${SLUG}/posts.json`;

        let passes = 0;
        const outcome = await commitPosts({
            store,
            slug: SLUG,
            log: { info() {} },
            mutate: (posts) => {
                passes++;
                return hide(posts);
            }
        });

        assert.equal(passes, 2, 'the mutation must re-run, not be replayed from a stale read');
        assert.ok(!outcome.error);
        assert.equal(store.json('rendered', `${SLUG}/posts.json`)[0].hidden, true);
    });

    test('a site with no posts.json is reported rather than created', async () => {
        const outcome = await commitPosts({
            store: memoryStore(),
            slug: SLUG,
            mutate: hide,
            log: { info() {} }
        });
        assert.equal(outcome.error, 'not found');
    });

    test('a refused mutation writes nothing at all', async () => {
        const store = seeded();
        const before = store.blobs.get(`rendered/${SLUG}/posts.json`).etag;

        const outcome = await commitPosts({
            store,
            slug: SLUG,
            log: { info() {} },
            mutate: () => ({ error: 'not editable: originalFrom' })
        });

        assert.match(outcome.error, /not editable/);
        assert.equal(store.blobs.get(`rendered/${SLUG}/posts.json`).etag, before);
    });
});
