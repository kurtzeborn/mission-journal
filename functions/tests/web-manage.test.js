// The operator's page, driven through the real script.
//
// It is the entire recovery path for a deletion somebody regrets, and it will
// go months without being opened. Which means nothing about it will be noticed
// by being used -- the first time it is loaded in anger, it either works or a
// family's letters run out of days while somebody debugs it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const DELETIONS = [
    {
        slug: 'elder.example',
        deletedAt: '2026-08-08T09:00:00.000Z',
        deletedBy: 'mum@example.com',
        reason: 'wrong archive',
        purgeAfter: '2026-09-07T09:00:00.000Z'
    },
    {
        slug: 'sister.example',
        deletedAt: '2026-08-10T09:00:00.000Z',
        deletedBy: 'dad@example.com',
        reason: '',
        purgeAfter: '2026-09-09T09:00:00.000Z'
    }
];

async function manage({ answer }) {
    const view = page({ html: 'manage.html', path: '/manage' });
    const net = fetching(answer);
    run('manage.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

const listed = (deletions) => async () => ({ status: 200, body: { deletions } });

const rows = (view) => view.el('rows').children;
const cells = (row) => row.children.map((cell) => cell.textContent);
const restoreButton = (row) => row.descendants().find((node) => node.tagName === 'button');

const press = async (view, index = 0) => {
    await restoreButton(rows(view)[index]).dispatch('click');
    await settled();
};

describe('what an operator is shown', () => {
    test('one row per archive still waiting to be erased', async () => {
        const view = await manage({ answer: listed(DELETIONS) });

        assert.equal(rows(view).length, 2);
        assert.equal(view.el('deletions').hidden, false);
    });

    test('the archive name, who deleted it, and why', async () => {
        const view = await manage({ answer: listed(DELETIONS) });

        const [slug, , by, reason] = cells(rows(view)[0]);
        assert.equal(slug, 'elder.example');
        assert.equal(by, 'mum@example.com');
        assert.equal(reason, 'wrong archive');
    });

    test('with a dash where a reason was left blank', async () => {
        // An empty cell reads as a rendering fault. A dash reads as an answer.
        assert.equal(cells(rows(await manage({ answer: listed(DELETIONS) }))[1])[3], '\u2014');
    });

    test('and dates a person can read, not timestamps', async () => {
        // What matters is how many days are left, and nobody counts those off
        // an ISO string.
        const [, deletedAt, , , purgeAfter] = cells(rows(await manage({ answer: listed(DELETIONS) }))[0]);

        assert.doesNotMatch(deletedAt, /T\d\d:/);
        assert.doesNotMatch(purgeAfter, /T\d\d:/);
        assert.match(purgeAfter, /2026/);
    });

    test('a reason reaches the page as text, not as markup', async () => {
        // Free text an owner typed into a form, shown to the one account that
        // can restore archives. The harness has no parser, so what this pins
        // is that the value arrives whole -- which it only can if the script
        // set textContent rather than building a string of HTML.
        const nasty = '<img src=x onerror=alert(1)>';
        const view = await manage({ answer: listed([{ ...DELETIONS[0], reason: nasty }]) });

        assert.equal(cells(rows(view)[0])[3], nasty);
    });
});

describe('the ordinary state, which is nothing at all', () => {
    test('says so, rather than showing an empty table', async () => {
        const view = await manage({ answer: listed([]) });

        assert.match(view.text('state'), /No archives are waiting/i);
        assert.equal(view.el('deletions').hidden, true);
    });

    test('and a body that is not a list is treated as nothing', async () => {
        const view = await manage({ answer: async () => ({ status: 200, body: {} }) });

        assert.match(view.text('state'), /No archives are waiting/i);
    });
});

describe('who the page tells nothing to', () => {
    test('a signed-in visitor who is not an operator sees nothing here', async () => {
        // The API answers 404 rather than 403 so the route is not confirmed,
        // and the page must not undo that by explaining what it would have
        // shown.
        const view = await manage({ answer: async () => ({ status: 404, body: '' }) });

        assert.equal(view.text('state'), 'Nothing here.');
        assert.equal(view.el('deletions').hidden, true);
    });

    test('and a server that cannot be reached is not mistaken for one', async () => {
        const view = await manage({
            answer: async () => {
                throw new Error('offline');
            }
        });

        assert.match(view.text('state'), /Could not load/i);
    });

    test('nobody signed in at all is sent to the chooser, not to a provider', async () => {
        // Two providers now. Sending a Google operator straight at Microsoft
        // strands them on an account this service has never heard of.
        const view = await manage({ answer: async () => ({ status: 401, body: '' }) });

        assert.match(view.context.location.href, /^\/login\.html\?post_login_redirect_uri=/);
    });
});

describe('putting one back', () => {
    const restoring = (reply) => async (url, init) =>
        init?.method === 'POST' ? reply : { status: 200, body: { deletions: DELETIONS } };

    const restores = (view) => view.calls.filter((call) => call.method === 'POST');

    test('asks the server about that archive and no other', async () => {
        const view = await manage({ answer: restoring({ status: 200, body: { slug: 'elder.example' } }) });

        await press(view);

        assert.equal(restores(view).length, 1);
        assert.match(restores(view)[0].url, /\/api\/manage\/deletions\/elder\.example\/restore$/);
    });

    test('and says the family can read it again', async () => {
        const view = await manage({ answer: restoring({ status: 200, body: { slug: 'elder.example' } }) });

        await press(view);

        assert.match(view.text('said'), /is back/i);
    });

    test('a slug somebody else has taken is explained, not just refused', async () => {
        // The dangerous case: deletion does not reserve the name, so a
        // different family may be standing there now. "Failed" would send an
        // operator looking for a bug instead of for the new owner.
        const view = await manage({ answer: restoring({ status: 409, body: { error: 'slug in use' } }) });

        await press(view);

        assert.match(view.text('said'), /belongs to somebody else/i);
    });

    test('and after a refusal the button can be pressed again', async () => {
        const view = await manage({ answer: restoring({ status: 404, body: { error: 'not deleted' } }) });

        await press(view);

        assert.equal(restoreButton(rows(view)[0]).disabled, false);
        assert.match(view.text('said'), /Nothing was changed/i);
    });

    test('a network failure says nothing was restored, and lets them retry', async () => {
        const view = await manage({
            answer: async (url, init) => {
                if (init?.method === 'POST') throw new Error('offline');
                return { status: 200, body: { deletions: DELETIONS } };
            }
        });

        await press(view);

        assert.match(view.text('said'), /Nothing was restored/i);
        assert.equal(restoreButton(rows(view)[0]).disabled, false);
    });

    test('a success redraws the list rather than leaving a stale row', async () => {
        // The restored row's button would now restore an archive that is not
        // deleted. Leaving it on screen is an invitation to press it.
        let listings = 0;
        const view = await manage({
            answer: async (url, init) => {
                if (init?.method === 'POST') return { status: 200, body: { slug: 'elder.example' } };
                listings += 1;
                return { status: 200, body: { deletions: listings > 1 ? [DELETIONS[1]] : DELETIONS } };
            }
        });

        await press(view);

        assert.deepEqual(
            rows(view).map((row) => cells(row)[0]),
            ['sister.example']
        );
    });
});
