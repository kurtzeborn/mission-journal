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

// Both halves of the page, routed by URL. Deletions defaults to none, because
// most of what follows is about the other table and an empty deletions list is
// the ordinary state anyway.
const serving = ({ flow, deletions = [] }) => async (url) =>
    url.includes('last-received')
        ? { status: 200, body: flow }
        : { status: 200, body: { deletions } };

const ARCHIVES = [
    {
        slug: 'elder.recent',
        name: 'Elder Recent',
        state: 'live',
        lastPostAt: '2026-08-18',
        lastReceivedAt: '2026-08-19T06:00:00.000Z',
        held: 0,
        expiresAt: ''
    },
    {
        slug: 'sister.waiting',
        name: '',
        state: 'pending',
        lastPostAt: '',
        lastReceivedAt: '2026-07-01T06:00:00.000Z',
        held: 3,
        expiresAt: '2026-08-30T06:00:00.000Z'
    }
];

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

describe('the other table, which is every archive there is', () => {
    const flowRows = (view) => view.el('flow-rows').children;

    const arriving = async (flow) => manage({ answer: serving({ flow }) });

    test('one row per archive, with both dates kept apart', async () => {
        // They are different questions. `lastPostAt` is the date the letter
        // carries; `lastReceivedAt` is the moment it landed here.
        const view = await arriving({ lastReceivedAt: ARCHIVES[0].lastReceivedAt, archives: ARCHIVES });

        assert.equal(flowRows(view).length, 2);
        assert.equal(view.el('flow').hidden, false);

        const [slug, name, state, received, posted] = cells(flowRows(view)[0]);
        assert.equal(slug, 'elder.recent');
        assert.equal(name, 'Elder Recent');
        assert.equal(state, 'live');
        assert.match(received, /2026/);
        assert.match(posted, /2026/);
        assert.doesNotMatch(received, /T\d\d:/);
    });

    test('the headline says when anything last arrived anywhere', async () => {
        // The one fact somebody opens this page for. Said out loud rather than
        // left to be read off the top row, because reading it off the table
        // means trusting the sort.
        const days = 4;
        const when = new Date(Date.now() - days * 86400000).toISOString();
        const view = await arriving({ lastReceivedAt: when, archives: ARCHIVES });

        assert.match(view.text('flow-state'), /last received a letter 4 days ago/i);
    });

    test('an archive that has never had a letter shows dashes, not blanks', async () => {
        // Rows written before arrivals were recorded have no date at all. An
        // empty cell reads as a rendering fault.
        const view = await arriving({
            lastReceivedAt: '',
            archives: [{ slug: 'elder.new', name: '', state: 'live', lastPostAt: '', lastReceivedAt: '', held: 0 }]
        });

        assert.deepEqual(cells(flowRows(view)[0]), ['elder.new', '\u2014', 'live', '\u2014', '\u2014', '\u2014']);
        assert.match(view.text('flow-state'), /No letters have arrived/i);
    });

    test('letters waiting say how many and until when', async () => {
        const view = await arriving({ lastReceivedAt: ARCHIVES[0].lastReceivedAt, archives: ARCHIVES });

        assert.match(cells(flowRows(view)[1])[5], /^3 letters, until /);
    });

    test('letters stuck on a live archive say so without a date', async () => {
        // Not a pending archive counting down -- promotion failed partway and
        // left the only copy of somebody's mail where nothing reads it.
        const view = await arriving({
            lastReceivedAt: '2026-08-19T06:00:00.000Z',
            archives: [{ ...ARCHIVES[0], held: 1 }]
        });

        assert.equal(cells(flowRows(view)[0])[5], '1 letter');
    });

    test('a name reaches the page as text, not as markup', async () => {
        // A display name taken from an email header the service did not write.
        const nasty = '<img src=x onerror=alert(1)>';
        const view = await arriving({ lastReceivedAt: '', archives: [{ ...ARCHIVES[0], name: nasty }] });

        assert.equal(cells(flowRows(view)[0])[1], nasty);
    });

    test('and a failure here does not take the deletions down with it', async () => {
        // Two independent questions. An operator who came to restore an
        // archive must still be able to.
        const view = await manage({
            answer: async (url) =>
                url.includes('last-received')
                    ? { status: 500, body: '' }
                    : { status: 200, body: { deletions: DELETIONS } }
        });

        assert.match(view.text('flow-state'), /Could not load/i);
        assert.equal(view.el('flow').hidden, true);
        assert.equal(rows(view).length, 2);
    });
});

describe('who the page tells nothing to', () => {
    test('a signed-in visitor who is not an operator is shown a dead end', async () => {
        // The API answers 404 rather than 403 so the route is not confirmed,
        // and the page must not undo that by explaining what it would have
        // shown.
        const view = await manage({ answer: async () => ({ status: 404, body: '' }) });

        assert.equal(view.el('missing').hidden, false);
        assert.equal(view.el('loading').hidden, true);
    });

    test('and is told nothing about what the page is for', async () => {
        // The whole heading and explanation used to render for every signed-in
        // visitor, including a line assuring them nobody else could see the
        // page -- read only by the people it was untrue for. Found by opening
        // the URL in a private window on an unrelated account.
        const view = await manage({ answer: async () => ({ status: 404, body: '' }) });

        assert.equal(view.el('tooling').hidden, true);
        assert.equal(view.el('deletions').hidden, true);
        assert.equal(view.el('flow').hidden, true);
        assert.doesNotMatch(view.context.document.title, /deleted|archive|tooling/i);
    });

    test('an operator is shown all of it', async () => {
        const view = await manage({ answer: listed(DELETIONS) });

        assert.equal(view.el('tooling').hidden, false);
        assert.equal(view.el('missing').hidden, true);
        assert.match(view.context.document.title, /Service tooling/);
    });

    test('and a server that cannot be reached is not mistaken for one', async () => {
        // An offline operator must not be told the page does not exist, or
        // they will go looking for the wrong problem.
        const view = await manage({
            answer: async () => {
                throw new Error('offline');
            }
        });

        assert.match(view.text('loading'), /Could not load/i);
        assert.equal(view.el('missing').hidden, true);
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
