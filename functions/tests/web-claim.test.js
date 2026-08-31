// The walk through the claim page, from opening the link to reading letters.
//
// This is the only page that turns a signed link into an archive, and the
// person on it is frequently not yet sure the site is real. What is tested
// here is the shape of that walk rather than its wording: how many steps it
// takes, and that the token never surfaces anywhere a URL gets recorded.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const TOKEN = 'a-token-from-the-email';

/** The page with the script loaded and its first render finished. */
async function claimPage({ answer, hash = `#${TOKEN}` }) {
    const view = page({ html: 'claim.html', path: '/claim', hash });
    const net = fetching(answer);
    run(['page.js', 'claim.js'], { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

/** Answers describe with `described`, `/.auth/me` with `signedInAs`. */
const server = ({ described, signedInAs = null, redeem }) =>
    async (url) => {
        if (url === '/.auth/me') {
            return signedInAs
                ? { status: 200, body: { clientPrincipal: { userDetails: signedInAs } } }
                : { status: 401, body: {} };
        }
        if (url === '/api/claim/describe') return described;
        if (url === '/api/claim/redeem') return redeem;
        throw new Error(`unexpected call to ${url}`);
    };

const READY = {
    status: 200,
    body: { status: 'ready', sender: 'elder.example@missionary.org', messageCount: 3 }
};

const REDEEMED = {
    status: 200,
    body: { status: 'ok', slug: 'elder.example', promoted: { promoted: 3 } }
};

describe('setting an archive up from a claim link', () => {
    test('the token goes in a POST body, never in the address bar', async () => {
        // The whole reason it arrives in the fragment. missionary.org fetches
        // links out of mail before anyone reads them, and a token in a query
        // string is in our own logs before anybody decided it should be.
        const view = await claimPage({ answer: server({ described: READY }) });

        const described = view.calls.find((c) => c.url === '/api/claim/describe');
        assert.equal(described.body.token, TOKEN);
        assert.doesNotMatch(view.context.location.href, /a-token/);
    });

    test('nothing is claimed until a button is pressed', async () => {
        // Arriving at the page must not spend the link, for the same reason.
        const view = await claimPage({
            answer: server({ described: READY, signedInAs: 'g.example@gmail.com', redeem: REDEEMED })
        });

        assert.equal(view.el('claim-form').hidden, false);
        assert.ok(!view.calls.some((c) => c.url === '/api/claim/redeem'));
    });

    test('submitting sends the token and lands on the archive', async () => {
        const view = await claimPage({
            answer: server({ described: READY, signedInAs: 'g.example@gmail.com', redeem: REDEEMED })
        });

        view.el('display-name').value = 'Elder Example';
        await view.el('claim-form').dispatch('submit');

        const redeemed = view.calls.find((c) => c.url === '/api/claim/redeem');
        assert.equal(redeemed.body.token, TOKEN);
        assert.equal(redeemed.body.displayName, 'Elder Example');
        assert.equal(view.context.location.href, '/elder.example/');
    });

    test('nobody is asked to press a second button to get in', async () => {
        // The page that stood here announced the archive was ready and offered
        // a link to it, which is what the redirect does without the click. The
        // invitation page dropped its own for the same reason.
        const view = await claimPage({ answer: server({ described: READY }) });

        assert.doesNotMatch(view.source, /id="done"/);
    });

    test('a missionary joining a live archive is not asked to name it again', async () => {
        // The name is months old and the answer is meant to be left alone, so
        // the question is not put. Settings is where one gets corrected.
        const view = await claimPage({
            answer: server({
                described: {
                    status: 200,
                    body: { ...READY.body, kind: 'missionary', alreadyOwned: true, displayName: 'Elder Example' }
                },
                signedInAs: 'g.example@gmail.com',
                redeem: REDEEMED
            })
        });

        assert.equal(view.el('display-name-block').hidden, true);
        assert.equal(view.text('claim-submit'), 'Get access');

        // Still sent, so the server sees the name unchanged rather than blank.
        await view.el('claim-form').dispatch('submit');
        assert.equal(view.calls.find((c) => c.url === '/api/claim/redeem').body.displayName, 'Elder Example');
    });
});
