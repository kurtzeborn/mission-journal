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

        const [slug, state, received, posted] = cells(flowRows(view)[0]);
        assert.equal(slug, 'elder.recent');
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

        assert.deepEqual(cells(flowRows(view)[0]), ['elder.new', 'live', '\u2014', '\u2014', '\u2014']);
        assert.match(view.text('flow-state'), /No letters have arrived/i);
    });

    test('letters waiting say how many and until when', async () => {
        const view = await arriving({ lastReceivedAt: ARCHIVES[0].lastReceivedAt, archives: ARCHIVES });

        assert.match(cells(flowRows(view)[1])[4], /^3 letters, until /);
    });

    test('letters stuck on a live archive say so without a date', async () => {
        // Not a pending archive counting down -- promotion failed partway and
        // left the only copy of somebody's mail where nothing reads it.
        const view = await arriving({
            lastReceivedAt: '2026-08-19T06:00:00.000Z',
            archives: [{ ...ARCHIVES[0], held: 1 }]
        });

        assert.equal(cells(flowRows(view)[0])[4], '1 letter');
    });

    test('the display name is not repeated beside the slug it made', async () => {
        // One fewer column on the table that grows forever. The slug is
        // derived from the name, so the two said the same thing twice.
        const view = await arriving({ lastReceivedAt: '', archives: ARCHIVES });

        assert.equal(cells(flowRows(view)[0]).length, 5);
        assert.equal(cells(flowRows(view)[0]).includes('Elder Recent'), false);
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

const REFUSED = [
    {
        slug: 'elder.stuck',
        ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        at: '2026-08-02T09:00:00.000Z',
        sender: 'mum@example.com',
        author: 'elder.stuck@missionary.org',
        subject: 'Week one',
        reason: 'bootstrap-unverified'
    },
    {
        slug: 'sister.stuck',
        ulid: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
        at: '2026-08-01T09:00:00.000Z',
        sender: 'dad@example.com',
        author: 'sister.stuck@missionary.org',
        subject: '',
        reason: 'bootstrap-not-attached'
    }
];

// The third table, which is the one with buttons that force things. Every row
// in it is a family who tried to start an archive and could not, so an
// operator reading it is deciding on somebody's behalf -- what the tests below
// pin is that the page says which letter, from whom, and refused why, before
// any of that is offered.
describe('the letters that never got in', () => {
    const refusing = (rejections, over = {}) => async (url) =>
        url.includes('rejections')
            ? { status: 200, body: { rejections }, ...over }
            : { status: 200, body: { deletions: [] } };

    const refusedRows = (view) => view.el('refused-rows').children;

    test('one row per refusal, newest as the API ordered it', async () => {
        const view = await manage({ answer: refusing(REFUSED) });

        assert.equal(refusedRows(view).length, 2);
        assert.equal(view.el('refused').hidden, false);
        assert.equal(cells(refusedRows(view)[0])[0], 'elder.stuck');
    });

    test('who forwarded it, what it was called, and why it was refused', async () => {
        const view = await manage({ answer: refusing(REFUSED) });

        const [slug, sender, subject, refused, why] = cells(refusedRows(view)[0]);
        assert.equal(slug, 'elder.stuck');
        assert.equal(sender, 'mum@example.com');
        assert.equal(subject, 'Week one');
        assert.doesNotMatch(refused, /T\d\d:/);
        // Not the raw reason code. The person reading this has to decide
        // whether to force the letter through, and `bootstrap-unverified`
        // does not tell them anything about the letter.
        assert.match(why, /signature/i);
    });

    test('a subject reaches the page as text, not as markup', async () => {
        // Somebody else's words, out of a header the service did not write,
        // shown to the one account that can force an archive into existence.
        const nasty = '<img src=x onerror=alert(1)>';
        const view = await manage({ answer: refusing([{ ...REFUSED[0], subject: nasty }]) });

        assert.equal(cells(refusedRows(view)[0])[2], nasty);
    });

    test('three buttons, in the order they should be tried', async () => {
        const view = await manage({ answer: refusing(REFUSED) });

        assert.deepEqual(
            refusedRows(view)[0]
                .descendants()
                .filter((node) => node.tagName === 'button')
                .map((node) => node.textContent),
            ['Retry', 'Advise again', 'Start it anyway']
        );
    });

    test('a retry asks for nothing but a retry', async () => {
        // The harmless door: the same rules, run again. Worth doing whenever
        // the rules have changed, which is what stranded the letters this was
        // built for.
        const view = await manage({ answer: refusing(REFUSED) });
        await view.button('refused-rows', 'Retry').dispatch('click');
        await settled();

        assert.ok(
            view.calls.some(
                (call) =>
                    call.url ===
                        '/api/manage/rejections/elder.stuck/01ARZ3NDEKTSV4RRFFQ69G5FAV/retry' &&
                    call.method === 'POST'
            ),
            'the retry never reached the API'
        );
    });

    test('advising again carries the address and the right advice', async () => {
        // Two kinds of nudge, and sending the wrong one is worse than sending
        // nothing: it tells somebody to do the thing they already did.
        const view = await manage({ answer: refusing(REFUSED) });
        await view.button('refused-rows', 'Advise again').dispatch('click');
        await settled();

        const call = view.calls.find((c) => c.url.includes('/advise'));
        assert.ok(call, 'nothing was sent');
        assert.match(call.url, /to=mum%40example\.com/);
        assert.match(call.url, /kind=rebuilt/);
    });

    test('forcing one through is asked about first', async () => {
        // The only irreversible thing on the page and the only one that
        // creates something out of evidence we do not have.
        const view = await manage({ answer: refusing(REFUSED) });
        view.context.confirmed = false;

        await view.button('refused-rows', 'Start it anyway').dispatch('click');
        await settled();

        assert.equal(
            view.calls.some((call) => call.url.includes('/bypass')),
            false,
            'an archive was created after the question was declined'
        );
    });

    test('and goes through when the answer is yes', async () => {
        const view = await manage({ answer: refusing(REFUSED) });
        await view.button('refused-rows', 'Start it anyway').dispatch('click');
        await settled();

        assert.ok(view.calls.some((call) => call.url.includes('/bypass')));
    });

    test('a retry that fails again says what it failed on', async () => {
        // The ordinary outcome, and silence here would leave an operator
        // pressing the button a second time.
        const view = await manage({
            answer: async (url) =>
                url.includes('/retry')
                    ? { status: 200, body: { status: 'rejected', reason: 'bootstrap-unverified' } }
                    : url.includes('rejections')
                        ? { status: 200, body: { rejections: REFUSED } }
                        : { status: 200, body: { deletions: [] } }
        });

        await view.button('refused-rows', 'Retry').dispatch('click');
        await settled();

        assert.match(view.text('refused-said'), /Still refused: bootstrap-unverified/);
    });

    test('nothing to show is said plainly, because it is the good outcome', async () => {
        const view = await manage({ answer: refusing([]) });

        assert.match(view.text('refused-state'), /No first letters have been turned away/i);
        assert.equal(view.el('refused').hidden, true);
    });

    test('and a failure here does not take the rest of the page down', async () => {
        const view = await manage({
            answer: async (url) =>
                url.includes('rejections')
                    ? { status: 500, body: '' }
                    : { status: 200, body: { deletions: DELETIONS } }
        });

        assert.match(view.text('refused-state'), /Could not load/i);
        assert.equal(view.el('refused').hidden, true);
        assert.equal(rows(view).length, 2);
    });
});

const WAITING = [
    {
        slug: 'mallory.example',
        sender: 'mallory.example@missionary.org',
        recipient: 'mum@example.com',
        messageCount: 1,
        hasDirect: false,
        createdAt: '2026-08-23T03:34:38.000Z',
        expiresAt: '2026-09-06T03:34:38.000Z',
        offeredAt: null,
        offerCount: 0
    },
    {
        slug: 'sister.told',
        sender: 'sister.told@missionary.org',
        recipient: 'dad@example.com',
        messageCount: 4,
        hasDirect: false,
        createdAt: '2026-08-01T09:00:00.000Z',
        expiresAt: '2026-09-15T09:00:00.000Z',
        offeredAt: '2026-08-02T09:00:00.000Z',
        offerCount: 1
    }
];

// The fourth table. The letters are safe, so nothing here is urgent in the way
// a refusal is -- but nobody has been told they exist, and the countdown is
// running. What the tests pin is that an operator can tell the two rows apart
// before pressing anything: one has never been offered, one has.
describe('the archives nobody has claimed', () => {
    const waiting = (pending, over = {}) => async (url) =>
        url.includes('manage/pending')
            ? { status: 200, body: { pending }, ...over }
            : { status: 200, body: { deletions: [] } };

    const waitingRows = (view) => view.el('waiting-rows').children;

    test('says where the link would go, and whether one ever went', async () => {
        const view = await manage({ answer: waiting(WAITING) });

        const [slug, to, letters, offered] = cells(waitingRows(view)[0]);
        assert.equal(slug, 'mallory.example');
        assert.equal(to, 'mum@example.com');
        assert.equal(letters, '1');
        // The whole reason the table exists: this is the row where the one
        // email that would have told anybody never arrived.
        assert.equal(offered, 'never');
    });

    test('a first offer is not asked about, having nothing to break', async () => {
        const view = await manage({ answer: waiting(WAITING) });
        view.context.confirmed = false;

        await view.button('waiting-rows', 'Send the claim link').dispatch('click');
        await settled();

        assert.ok(
            view.calls.some(
                (call) =>
                    call.url === '/api/manage/pending/mallory.example/offer' && call.method === 'POST'
            ),
            'the offer never reached the API'
        );
    });

    test('a second one is, because it invalidates the first', async () => {
        const view = await manage({ answer: waiting(WAITING) });
        view.context.confirmed = false;

        await view.button('waiting-rows', 'Send it again').dispatch('click');
        await settled();

        assert.equal(
            view.calls.some((call) => call.url.includes('sister.told')),
            false,
            'a live claim link was invalidated after the question was declined'
        );
    });

    test('and names the address it reached', async () => {
        const view = await manage({
            answer: async (url) =>
                url.includes('/offer')
                    ? { status: 200, body: { slug: 'mallory.example', status: 'sent' } }
                    : url.includes('manage/pending')
                        ? { status: 200, body: { pending: WAITING } }
                        : { status: 200, body: { deletions: [] } }
        });

        await view.button('waiting-rows', 'Send the claim link').dispatch('click');
        await settled();

        assert.match(view.text('waiting-said'), /mum@example\.com/);
    });

    test('the allowlist is named rather than reported as a failure', async () => {
        // While it is narrow this is the likeliest answer, and "something went
        // wrong" would send an operator to the logs for a setting.
        const view = await manage({
            answer: async (url) =>
                url.includes('/offer')
                    ? { status: 200, body: { slug: 'mallory.example', status: 'blocked' } }
                    : url.includes('manage/pending')
                        ? { status: 200, body: { pending: WAITING } }
                        : { status: 200, body: { deletions: [] } }
        });

        await view.button('waiting-rows', 'Send the claim link').dispatch('click');
        await settled();

        assert.match(view.text('waiting-said'), /not on the mail allowlist/i);
    });

    test('a site with no return address offers no button to press', async () => {
        const view = await manage({
            answer: waiting([{ ...WAITING[0], recipient: '' }])
        });

        const row = waitingRows(view)[0];
        assert.equal(
            row.descendants().some((node) => node.tagName === 'button'),
            false,
            'a claim link was offered with nowhere to send it'
        );
        assert.match(cells(row)[5], /No return address/i);
    });

    test('nothing waiting is said plainly', async () => {
        const view = await manage({ answer: waiting([]) });

        assert.match(view.text('waiting-state'), /No archives are waiting/i);
        assert.equal(view.el('waiting').hidden, true);
    });

    test('and a failure here does not take the rest of the page down', async () => {
        const view = await manage({
            answer: async (url) =>
                url.includes('manage/pending')
                    ? { status: 500, body: '' }
                    : { status: 200, body: { deletions: DELETIONS } }
        });

        assert.match(view.text('waiting-state'), /Could not load/i);
        assert.equal(view.el('waiting').hidden, true);
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
