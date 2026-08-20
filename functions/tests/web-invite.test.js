// What the invitation landing page tells whoever opened the link.
//
// The person here may be the invited relative, or may be a stranger the mail
// was forwarded to by accident. Every branch below decides what one of those
// two is told, and several of them are the difference between somebody
// re-copying a link that was never broken and somebody asking for a new one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const TOKEN = 'a-token-from-the-email';

/** The page with the script loaded and its first render finished. */
async function invitePage({ answer, hash = `#${TOKEN}` }) {
    const view = page({ html: 'invite.html', path: '/invite', hash });
    const net = fetching(answer);
    run('invite.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

/** Answers describe with `described`, `/.auth/me` with `signedInAs`. */
const server = ({ described, signedInAs = null, accept }) =>
    async (url, init) => {
        if (url === '/.auth/me') {
            return signedInAs
                ? { status: 200, body: { clientPrincipal: { userDetails: signedInAs } } }
                : { status: 401, body: {} };
        }
        if (url === '/api/invite/describe') return described;
        if (url === '/api/invite/accept') return accept;
        throw new Error(`unexpected call to ${url}`);
    };

const READY = {
    status: 200,
    body: { status: 'ready', slug: 'elder.example', role: 'reader', invitedBy: 'mum@example.com', missionary: 'Elder Example' }
};

describe('opening an invitation', () => {
    test('leads with who sent it and whose letters they are', async () => {
        // A relative who was not expecting this has to be able to tell in one
        // line that it is not a scam, and the only two facts that do that are
        // the name of the person who invited them and whose archive it is.
        const view = await invitePage({ answer: server({ described: READY }) });

        assert.equal(
            view.text('ready-lede'),
            "mum@example.com has invited you to read Elder Example's letters."
        );
        assert.equal(view.el('ready').hidden, false);
    });

    test('an archive with no name yet still reads as a sentence', async () => {
        const view = await invitePage({
            answer: server({ described: { status: 200, body: { ...READY.body, missionary: '', invitedBy: '' } } })
        });

        assert.equal(view.text('ready-lede'), 'Somebody has invited you to read a missionary\u2019s letters.');
    });

    test('the token goes in a POST body, never in the address bar', async () => {
        // The whole reason it arrives in the fragment. A token in a query
        // string is in our own request logs before anybody has decided
        // whether it should be.
        const view = await invitePage({ answer: server({ described: READY }) });

        const describe = view.calls.find((c) => c.url === '/api/invite/describe');
        assert.equal(describe.body.token, TOKEN);
        assert.doesNotMatch(view.context.location.href, /a-token/);
    });

    test('a link with nothing after the hash is refused without asking the server', async () => {
        const view = await invitePage({ answer: server({ described: READY }), hash: '' });

        assert.equal(view.calls.length, 0);
        assert.equal(view.text('failed-title'), 'This invitation cannot be used');
    });

    test('an owner invitation says what it is before it is accepted', async () => {
        // The stake is higher than a reader seat and the page is the last
        // place it can be said.
        const view = await invitePage({
            answer: server({ described: { status: 200, body: { ...READY.body, role: 'owner' } } })
        });

        assert.match(view.text('ready-role'), /invited as an owner/);
        assert.match(view.text('ready-role'), /invite other people/);
    });
});

describe('being told why a link will not work', () => {
    const cases = [
        ['expired', 'This invitation has expired'],
        ['accepted', 'This invitation has already been used'],
        ['invalid', 'This invitation cannot be used'],
        ['gone', 'That archive is no longer there']
    ];

    for (const [status, title] of cases) {
        test(`${status} is explained rather than reported`, async () => {
            const view = await invitePage({
                answer: server({ described: { status: 200, body: { status } } })
            });

            assert.equal(view.text('failed-title'), title);
            // Never left silent: a title with no next step is a dead end.
            assert.notEqual(view.text('failed-help'), '');
        });
    }

    test('a status we have no words for is treated as our fault', async () => {
        // The alternative tells somebody their link is broken and sends them
        // off to re-copy something that was never the problem.
        const view = await invitePage({
            answer: server({ described: { status: 500, body: { status: 'kaboom' } } })
        });

        assert.equal(view.text('failed-title'), 'Something is wrong on our end');
        assert.match(view.text('failed-detail'), /not a problem with your link/);
    });
});

describe('accepting', () => {
    test('a signed-out visitor is offered both providers and no Accept button', async () => {
        const view = await invitePage({ answer: server({ described: READY }) });

        assert.equal(view.el('signin-block').hidden, false);
        assert.equal(view.el('accept-form').hidden, true);
        assert.match(view.el('signin-aad').href, /post_login_redirect_uri=%2Finvite/);
        assert.match(view.el('signin-google').href, /post_login_redirect_uri=%2Finvite/);
    });

    test('a signed-in visitor is told which account is about to be granted access', async () => {
        // Many people have more than one, and the archive will answer for
        // exactly one of them. Saying so here is cheaper than the refusal
        // page they would otherwise meet later.
        const view = await invitePage({
            answer: server({ described: READY, signedInAs: 'g.example@gmail.com' })
        });

        assert.equal(view.el('accept-form').hidden, false);
        assert.equal(view.el('signin-block').hidden, true);
        assert.match(view.text('accept-as'), /signed in as g\.example@gmail\.com/);
    });

    test('accepting sends the token and lands on the archive', async () => {
        const view = await invitePage({
            answer: server({
                described: READY,
                signedInAs: 'g.example@gmail.com',
                accept: { status: 200, body: { status: 'ok', slug: 'elder.example', role: 'reader' } }
            })
        });

        await view.el('accept-form').dispatch('submit');

        const accepted = view.calls.find((c) => c.url === '/api/invite/accept');
        assert.equal(accepted.body.token, TOKEN);
        assert.equal(view.context.location.href, '/elder.example/');
    });

    test('nobody is asked to press a second button to get in', async () => {
        // The page that used to stand here said the acceptance had worked and
        // offered a link to the archive, which is what the redirect does
        // without the click.
        const view = await invitePage({ answer: server({ described: READY }) });

        assert.ok(!view.sections.includes('done'));
    });

    test('the summaries are offered by name, and off unless somebody asks', async () => {
        // A reader who says nothing should not start receiving mail because a
        // form defaulted them into it.
        const view = await invitePage({
            answer: server({ described: READY, signedInAs: 'g.example@gmail.com' })
        });

        assert.match(view.text('digest-lede'), /summaries of activity in the Elder Example archive/);
        assert.match(view.source, /<option value="off" selected>/);
    });

    test('the answer about email goes with it, because this is when we ask', async () => {
        // The only moment this question gets asked of somebody who was
        // invited. A page that dropped the answer would leave every reader on
        // the default, which is silence, and nobody would know.
        const view = await invitePage({
            answer: server({
                described: READY,
                signedInAs: 'g.example@gmail.com',
                accept: { status: 200, body: { status: 'ok', slug: 'elder.example', role: 'reader' } }
            })
        });

        view.el('digest').value = 'weekly';
        await view.el('accept-form').dispatch('submit');

        assert.equal(view.calls.find((c) => c.url === '/api/invite/accept').body.digestFrequency, 'weekly');
    });

    test('an invitation withdrawn between opening and accepting is caught', async () => {
        // Two round trips with a person's reading time in between, and an
        // owner may revoke in that window. The page cannot trust what it was
        // told a minute ago.
        const view = await invitePage({
            answer: server({
                described: READY,
                signedInAs: 'g.example@gmail.com',
                accept: { status: 200, body: { status: 'invalid' } }
            })
        });

        await view.el('accept-form').dispatch('submit');

        assert.equal(view.text('failed-title'), 'This invitation cannot be used');
        assert.doesNotMatch(view.context.location.href, /elder\.example/);
    });

    test('a session that lapsed while they read sends them back through the chooser', async () => {
        // The chooser, not a provider. This page offers both a moment earlier,
        // so hard-coding one here would send half the people whose session
        // lapsed mid-acceptance to an account the invitation was never for.
        const view = await invitePage({
            answer: server({
                described: READY,
                signedInAs: 'g.example@gmail.com',
                accept: { status: 401, body: {} }
            })
        });

        await view.el('accept-form').dispatch('submit');

        assert.match(view.context.location.href, /^\/login\.html\?/);
        assert.match(view.context.location.href, /post_login_redirect_uri=%2Finvite/);
    });
});
