// The one settings page that is not about an archive.
//
// Nothing on the way in asks the question any more, so everybody arrives here
// on `off` -- the families who joined before it existed and the ones who
// joined this morning alike. That is why the page is reached from the account
// menu rather than from a message: we are not sending them any.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetching, page, run, settled } from './web-dom.js';

const open = async (answer) => {
    const view = page({ html: 'email.html', path: '/email' });
    const net = fetching(answer);
    run('email.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { view, net };
};

const saved = { status: 200, body: { digestFrequency: 'weekly' } };

const loaded = (body) => (url, init) =>
    (init?.method ?? 'GET') === 'GET' ? { status: 200, body } : saved;

// This page is reached from the account menu, and until now it was the one
// signed-in page that did not carry that menu itself -- so the way in was also
// a dead end. The route is authenticated, so there is no signed-out state to
// draw and the menu ships visible.
describe('the masthead', () => {
    const source = readFileSync(new URL('../../web/email.html', import.meta.url), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '');

    test('carries the account menu, drawn by the script the landing page uses', () => {
        assert.match(source, /<details class="menu" id="menu">/);
        assert.match(source, /<script src="\/account\.js">/);
        assert.match(source, /href="\/\.auth\/logout"/);
    });
});

describe('showing somebody what they chose', () => {
    test('the setting comes back selected, not guessed at', async () => {
        const { view } = await open(loaded({ email: 'grandma@example.com', digestFrequency: 'monthly' }));

        assert.equal(view.el('ready').hidden, false);
        assert.equal(view.el('digest').value, 'monthly');
        assert.match(view.text('digest-as'), /grandma@example\.com/);
    });

    test('somebody who has never asked sees never, which is what they are getting', async () => {
        const { view } = await open(loaded({ email: 'grandma@example.com', digestFrequency: 'off' }));

        assert.equal(view.el('digest').value, 'off');
    });

    test('an address that pressed unsubscribe is told why nothing arrives', async () => {
        // Otherwise the page offers a choice it cannot honor and says
        // nothing about the statement standing above it.
        const { view } = await open(
            loaded({ email: 'grandma@example.com', digestFrequency: 'monthly', suppressed: true })
        );

        assert.equal(view.el('suppressed').hidden, false);
    });

    test('and one that did not is not told about a thing it has not done', async () => {
        const { view } = await open(
            loaded({ email: 'grandma@example.com', digestFrequency: 'monthly', suppressed: false })
        );

        assert.equal(view.el('suppressed').hidden, true);
    });

    test('a lapsed session offers sign-in rather than an error', async () => {
        const { view } = await open(() => ({ status: 401, body: {} }));

        assert.equal(view.el('signin').hidden, false);
        assert.match(view.el('signin-aad').href, /post_login_redirect_uri=%2Femail/);
    });

    test('an outage says it is ours, and does not send anybody to sign in again', async () => {
        const { view } = await open(() => {
            throw new Error('the network is down');
        });

        assert.equal(view.el('failed').hidden, false);
        assert.equal(view.el('signin').hidden, true);
    });
});

describe('changing it', () => {
    test('the choice is sent as itself, not as a form post', async () => {
        const { view, net } = await open(loaded({ email: 'grandma@example.com', digestFrequency: 'monthly' }));

        view.el('digest').value = 'weekly';
        await view.el('digest-form').dispatch('submit');

        const put = net.calls.find((call) => call.method === 'PUT');
        assert.equal(put.url, '/api/preferences');
        assert.equal(put.body.digestFrequency, 'weekly');
        assert.match(view.text('digest-as'), /Saved/);
    });

    test('a save that fails says so instead of pretending', async () => {
        const { view } = await open((url, init) =>
            (init?.method ?? 'GET') === 'GET'
                ? { status: 200, body: { email: 'grandma@example.com', digestFrequency: 'monthly' } }
                : { status: 500, body: {} }
        );

        await view.el('digest-form').dispatch('submit');

        assert.match(view.text('digest-as'), /did not save/);
        assert.equal(view.el('digest-submit').disabled, false, 'the button stayed dead');
    });

    test('a session that lapsed while the page sat open sends them back to sign in', async () => {
        const { view } = await open((url, init) =>
            (init?.method ?? 'GET') === 'GET'
                ? { status: 200, body: { email: 'grandma@example.com', digestFrequency: 'monthly' } }
                : { status: 401, body: {} }
        );

        await view.el('digest-form').dispatch('submit');

        assert.equal(view.el('signin').hidden, false);
    });
});

// The way back from an unsubscribe. It has to be here rather than in an email
// to somebody, because the one thing we have promised that address is that we
// will not email it.
describe('taking an unsubscribe back', () => {
    const suppressed = (over = {}) =>
        loaded({ email: 'grandma@example.com', digestFrequency: 'monthly', suppressed: true, ...over });

    test('the block is lifted by its own verb, not by the dropdown', async () => {
        const { view, net } = await open(suppressed());

        await view.el('resume').dispatch('click');
        await settled();

        const call = net.calls.find((c) => c.method === 'DELETE');
        assert.ok(call, 'nothing was sent');
        assert.equal(call.url, '/api/preferences/suppression');
    });

    test('and the panel goes, having stopped being true', async () => {
        const { view } = await open((url, init) =>
            init?.method === 'DELETE'
                ? { status: 200, body: { suppressed: false } }
                : { status: 200, body: { email: 'grandma@example.com', digestFrequency: 'monthly', suppressed: true } }
        );

        await view.el('resume').dispatch('click');
        await settled();

        assert.equal(view.el('suppressed').hidden, true);
    });

    test('a failure leaves the button alive and says so', async () => {
        // The worst outcome here is somebody believing they are back on the
        // list when they are not, and then waiting for mail that never comes.
        const { view } = await open((url, init) =>
            init?.method === 'DELETE'
                ? { status: 500, body: {} }
                : { status: 200, body: { email: 'grandma@example.com', digestFrequency: 'monthly', suppressed: true } }
        );

        await view.el('resume').dispatch('click');
        await settled();

        assert.equal(view.el('suppressed').hidden, false);
        assert.equal(view.el('resume').disabled, false, 'the button stayed dead');
        assert.match(view.text('resume-said'), /did not work/);
    });
});
