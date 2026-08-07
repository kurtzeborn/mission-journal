// What somebody is shown when an archive refuses them.
//
// This is the page an invitation most often goes wrong on, and it goes wrong
// in a way that looks like the service losing the letters: an invitation is
// accepted on one account, the link is opened later on a phone signed in to
// another, and the archive answers exactly as it would for an archive that
// does not exist. The API cannot tell those two apart -- that is deliberate,
// it is what stops the site list being enumerable -- so the page cannot claim
// which one happened. What it can do is name the account being refused, which
// is the one fact the visitor cannot see for themselves.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const SLUG = 'elder.example';

async function archive({ answer, path = `/${SLUG}/` }) {
    const view = page({ html: 'site.html', path });
    // The reader itself is not under test here; only what happens instead of
    // it when the letters never arrive.
    view.context.Reader = { mount() {} };
    const net = fetching(answer);
    run('app.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

const signedIn = (email, provider = 'google') => ({
    status: 200,
    body: { clientPrincipal: { userDetails: email, identityProvider: provider } }
});

describe('being turned away from an archive', () => {
    test('names the account, because that is the usual mistake', async () => {
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('other@example.com') : { status: 404, body: {} }
        });

        assert.equal(view.el('denied').hidden, false);
        assert.equal(view.el('denied-who').hidden, false);
        assert.equal(view.text('denied-email'), 'other@example.com');
        // The loading line has to go, or the page says both things at once.
        assert.equal(view.el('state').hidden, true);
    });

    test('offers a way back to the sign-in chooser, returning here', async () => {
        // Signing out and being dropped on the front page means finding the
        // archive again from an invitation email they may have deleted.
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('other@example.com') : { status: 404, body: {} }
        });

        assert.equal(
            view.el('denied-switch').href,
            `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(`/${SLUG}/`)}`
        );
    });

    test('says nothing about the account when it cannot find out which one', async () => {
        // Telling somebody which account they are on and being wrong about it
        // is worse than not saying.
        const view = await archive({
            answer: async (url) => (url === '/.auth/me' ? new Error('offline') : { status: 404, body: {} })
        });

        assert.equal(view.el('denied').hidden, false);
        assert.equal(view.el('denied-who').hidden, true);
        assert.equal(view.text('denied-email'), '');
    });

    test('asks for the identity once, not once per thing that wants it', async () => {
        // The masthead and the panel both need it and both run at once.
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('other@example.com') : { status: 404, body: {} }
        });

        assert.equal(view.calls.filter((c) => c.url === '/.auth/me').length, 1);
    });

    test('an expired session is a sign-in, not a refusal', async () => {
        // A 401 means "we do not know who you are", which is a different
        // sentence from "these are not yours" and has a different remedy.
        const view = await archive({ answer: async () => ({ status: 401, body: {} }) });

        assert.equal(view.el('denied').hidden, true);
        assert.match(view.context.location.href, /login\.html\?post_login_redirect_uri/);
    });

    test('the letters loading is not a refusal', async () => {
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me'
                    ? signedIn('mum@example.com')
                    : { status: 200, body: { slug: SLUG, role: 'reader', posts: [] } }
        });

        assert.equal(view.el('denied').hidden, true);
        assert.equal(view.el('download').hidden, false);
        // A reader has no use for a page that would refuse them.
        assert.equal(view.el('people').hidden, true);
    });

    test('an owner is offered the People page from the archive itself', async () => {
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me'
                    ? signedIn('mum@example.com')
                    : { status: 200, body: { slug: SLUG, role: 'owner', posts: [] } }
        });

        assert.equal(view.el('people').hidden, false);
        assert.equal(view.el('people').href, `/people/${SLUG}`);
    });
});

// Reaching the other archives you belong to.
//
// There is no dashboard, and every archive is behind a sign-in, so somebody
// who loses one URL has the signed-in root redirect and this control and
// nothing else. It is also the reason it appears on the refusal page: a person
// who has just been told no is exactly the person who has lost a URL.
describe('the archive switcher', () => {
    const belongsTo = (...slugs) => ({
        status: 200,
        body: {
            memberships: slugs.map((slug) => ({
                slug,
                missionaryDisplayName: `Elder ${slug.split('.')[1]}`
            }))
        }
    });

    const reading = (memberships, archiveAnswer = { status: 200, body: { slug: SLUG, role: 'reader', posts: [] } }) =>
        archive({
            answer: async (url) => {
                if (url === '/.auth/me') return signedIn('gran@example.com');
                if (url === '/api/memberships') return memberships;
                return archiveAnswer;
            }
        });

    test('does not appear for the one archive somebody is already reading', async () => {
        // Which is nearly everybody. A control whose only possible answer is
        // "you are already here" is friction between them and the letters.
        const view = await reading(belongsTo(SLUG));

        assert.equal(view.el('switcher').hidden, true);
    });

    test('lists the others by name when there is more than one', async () => {
        const view = await reading(belongsTo(SLUG, 'sister.backman'));

        assert.equal(view.el('switcher').hidden, false);
        assert.deepEqual(view.lines('switcher-list'), ['Elder backman']);
    });

    test('links to the archive, not to a page about it', async () => {
        const view = await reading(belongsTo(SLUG, 'sister.backman'));

        assert.equal(view.link('switcher-list', 'Elder backman').href, '/sister.backman/');
    });

    test('falls back to the slug when an archive has never been named', async () => {
        const view = await reading({
            status: 200,
            body: { memberships: [{ slug: SLUG }, { slug: 'sister.backman' }] }
        });

        assert.deepEqual(view.lines('switcher-list'), ['sister.backman']);
    });

    test('offers every archive to somebody who has just been refused', async () => {
        // Nothing is excluded here: the slug in the address bar is by
        // definition not one of theirs.
        const view = await reading(belongsTo('sister.backman', 'elder.other'), { status: 404, body: {} });

        assert.equal(view.el('denied').hidden, false);
        assert.deepEqual(view.lines('switcher-list'), ['Elder backman', 'Elder other']);
    });

    test('stays out of the way when the list cannot be fetched', async () => {
        // The letters are the point and they have already loaded. An error in
        // a masthead convenience must not be the thing anybody reads.
        const view = await reading({ status: 500, body: {} });

        assert.equal(view.el('switcher').hidden, true);
    });

    test('does not put a second round trip in front of the letters', async () => {
        const view = await reading(belongsTo(SLUG, 'sister.backman'));

        assert.equal(view.el('download').hidden, false);
    });
});

// The banner an operator sees on an archive they do not belong to.
//
// It guards against the likeliest failure by a long way: an operator
// forgetting which hat they are wearing and editing a real family's letter.
describe('operator access is stated on the page', () => {
    const loaded = (body) =>
        archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('ops@pdayletters.com') : { status: 200, body }
        });

    test('says so when the authority came from the operator setting', async () => {
        const view = await loaded({ slug: SLUG, role: 'owner', viaOperator: true, posts: [] });

        assert.equal(view.el('operator-banner').hidden, false);
    });

    test('says nothing to an owner on their own archive', async () => {
        // A warning that fires when nothing is wrong is one people learn to
        // stop reading.
        const view = await loaded({ slug: SLUG, role: 'owner', viaOperator: false, posts: [] });

        assert.equal(view.el('operator-banner').hidden, true);
    });

    test('says nothing when the API does not mention it at all', async () => {
        const view = await loaded({ slug: SLUG, role: 'reader', posts: [] });

        assert.equal(view.el('operator-banner').hidden, true);
    });
});
