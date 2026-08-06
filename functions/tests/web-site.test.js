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
