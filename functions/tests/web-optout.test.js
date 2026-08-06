// The page that makes it stop.
//
// The behaviour under test is mostly a refusal to act: the page must not
// suppress anybody merely by being loaded, because the things that load a
// mailed link before its recipient does are numerous, automated, and not the
// person the message was for.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const TOKEN = 'a-signed-token';

const open = async ({ answer, hash = `#${TOKEN}` }) => {
    const view = page({ html: 'optout.html', path: '/optout', hash });
    const net = fetching(answer);
    run('optout.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { view, net };
};

const ready = (email = 'grandma@example.com') => (url) =>
    url.endsWith('/describe') ? { status: 200, body: { status: 'ready', email } } : { status: 200, body: { status: 'ok' } };

describe('being offered a way out', () => {
    test('loading the page suppresses nobody', async () => {
        // The one that matters. A scanner opening this link must change
        // nothing, or the opt-out becomes a way for a mail filter to
        // unsubscribe somebody who never asked.
        const { net } = await open({ answer: ready() });

        assert.deepEqual(
            net.calls.map((c) => c.url),
            ['/api/optout/describe']
        );
    });

    test('it names the address before asking', async () => {
        const { view } = await open({ answer: ready('grandma@example.com') });

        assert.match(view.text('ready-lede'), /grandma@example\.com/);
        assert.equal(view.el('ready').hidden, false);
    });

    test('the token leaves in a body, never in the URL', async () => {
        const { net } = await open({ answer: ready() });

        assert.equal(net.calls[0].method, 'POST');
        assert.equal(net.calls[0].body.token, TOKEN);
        assert.doesNotMatch(net.calls[0].url, /a-signed-token/);
    });

    test('and is taken out of the address bar', async () => {
        const { view } = await open({ answer: ready() });

        assert.equal(view.context.location.hash, '');
        assert.equal(view.context.sessionStorage.getItem('optout-token'), TOKEN);
    });

    test('a reload after the hash is gone still works', async () => {
        // The consequence of stashing it: `history.replaceState` means a
        // refresh arrives with no fragment, and losing the token there would
        // strand somebody mid-decision.
        const view = page({ html: 'optout.html', path: '/optout', hash: '' });
        view.context.sessionStorage.setItem('optout-token', TOKEN);
        const net = fetching(ready());
        run('optout.js', { context: view.context, fetch: net.fetch });
        await settled();

        assert.equal(view.el('ready').hidden, false);
    });

    test('arriving with no token at all is a plain refusal, not a crash', async () => {
        const view = page({ html: 'optout.html', path: '/optout', hash: '' });
        const net = fetching(ready());
        run('optout.js', { context: view.context, fetch: net.fetch });
        await settled();

        assert.equal(view.el('failed').hidden, false);
        assert.equal(net.calls.length, 0);
    });
});

describe('pressing the button', () => {
    test('spends the token and says so', async () => {
        const { view, net } = await open({ answer: ready() });
        await view.el('stop-form').dispatch('submit');
        await settled();

        assert.equal(net.calls[1].url, '/api/optout');
        assert.equal(net.calls[1].method, 'POST');
        assert.equal(net.calls[1].body.token, TOKEN);
        assert.equal(view.el('done').hidden, false);
    });

    test('the stashed token is cleared, so a shared machine keeps nothing', async () => {
        const { view } = await open({ answer: ready() });
        await view.el('stop-form').dispatch('submit');
        await settled();

        assert.equal(view.context.sessionStorage.getItem('optout-token'), null);
    });

    test('a double press cannot send twice', async () => {
        const { view, net } = await open({ answer: ready() });
        await view.el('stop-form').dispatch('submit');
        await settled();

        assert.equal(view.el('stop-submit').disabled, true);
        assert.equal(net.calls.filter((c) => c.url === '/api/optout').length, 1);
    });

    test('says the archives they already have are untouched', async () => {
        // Otherwise the honest reading of "stop emailing me" is "delete my
        // access", and somebody loses their grandson's letters over an
        // unwanted invitation.
        const { view } = await open({ answer: ready() });

        assert.match(view.source, /does not remove you from any archive/i);
    });
});

describe('when it will not work', () => {
    test('a link that is not ours says so plainly', async () => {
        const { view } = await open({ answer: () => ({ status: 200, body: { status: 'invalid' } }) });

        assert.match(view.text('failed-title'), /cannot be used/i);
        assert.match(view.text('failed-detail'), /not created by us|incomplete/i);
    });

    test('our own outage is not blamed on their link', async () => {
        const { view } = await open({ answer: () => ({ status: 503, body: { status: 'unavailable' } }) });

        assert.match(view.text('failed-title'), /wrong on our end/i);
        assert.match(view.text('failed-detail'), /not a problem with your link/i);
    });

    test('every dead end offers a human who can do it by hand', async () => {
        // A broken opt-out has to fall back on a person, or the promise fails
        // for exactly the people least able to work around it.
        const { view } = await open({ answer: () => ({ status: 503, body: { status: 'unavailable' } }) });

        assert.match(view.text('failed-help'), /hello@pdayletters\.com/);
    });

    test('the network dropping mid-press does not claim success', async () => {
        const { view } = await open({
            answer: (url, init, n) =>
                n === 1 ? { status: 200, body: { status: 'ready', email: 'a@b.com' } } : new Error('offline')
        });

        await view.el('stop-form').dispatch('submit');
        await settled();

        assert.equal(view.el('done').hidden, true);
        assert.match(view.text('failed-title'), /wrong on our end/i);
    });
});
