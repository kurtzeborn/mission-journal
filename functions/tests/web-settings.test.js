// The settings page, driven through the real script.
//
// Almost all of this is the delete control. The rename half is two fields and
// a PUT; the delete half is the only thing on this site that destroys
// anything, and the interesting cases are the ones where it must refuse to.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetching, page, run, settled } from './web-dom.js';

const SLUG = 'elder.example';

const PROFILE = { slug: SLUG, displayName: 'Elder Example', returnDate: '' };

async function settings({ answer }) {
    const view = page({ html: 'settings.html', path: `/settings/${SLUG}` });
    const net = fetching(answer);
    run('settings.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

const loaded = (deleteAnswer) => async (url, init) =>
    init?.method === 'DELETE'
        ? deleteAnswer
        : { status: 200, body: PROFILE };

const gone = { status: 200, body: { slug: SLUG, purgeAfter: '2026-09-07T09:00:00.000Z', members: 2 } };

const deletes = (view) => view.calls.filter((call) => call.method === 'DELETE');

// Four short questions, each with a paragraph under it, made a page that read
// as an essay with inputs in it -- and pushed the last question off a phone
// screen. The explanations are still there; they are folded away until asked
// for.
describe('the explanation beside each field', () => {
    const source = readFileSync(new URL('../../web/settings.html', import.meta.url), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '');

    test('one per field, closed, and labeled with something a screen reader can read', () => {
        const hints = [...source.matchAll(/<details class="hint"([^>]*)>/g)];
        const marks = [...source.matchAll(/<summary class="hint__mark"([^>]*)>/g)];

        assert.equal(hints.length, 4);
        assert.equal(hints.filter(([, attrs]) => /\bopen\b/.test(attrs)).length, 0);
        assert.equal(marks.length, 4);
        assert.equal(marks.every(([, attrs]) => attrs.includes('aria-label=')), true);
    });
});

// Two of the three fields are dates, and both of them do something: one is
// what the archive counts up from in front of the whole family, the other is
// what the ownership reminders are scheduled against. A form that loses
// either on the way past is a setting that quietly turns itself off.
describe('the mission dates', () => {
    const filled = { ...PROFILE, startDate: '2025-06-15', returnDate: '2027-06-15' };

    const opened = (profile) =>
        settings({ answer: async () => ({ status: 200, body: profile }) });

    test('arrive filled in rather than blank', async () => {
        const view = await opened(filled);

        assert.equal(view.el('startDate').value, '2025-06-15');
        assert.equal(view.el('returnDate').value, '2027-06-15');
    });

    test('are empty, not the word undefined, when nobody has set them', async () => {
        const view = await opened({ slug: SLUG, displayName: 'Elder Example' });

        assert.equal(view.el('startDate').value, '');
        assert.equal(view.el('returnDate').value, '');
    });

    test('are both sent when the form is saved', async () => {
        const view = await settings({
            answer: async (url, init) =>
                init?.method === 'PUT' ? { status: 200, body: filled } : { status: 200, body: filled }
        });

        await view.el('profile').dispatch('submit');

        const put = view.calls.find((call) => call.method === 'PUT');
        assert.equal(put.body.startDate, '2025-06-15');
        assert.equal(put.body.returnDate, '2027-06-15');
    });

    test('are redrawn from the answer, not from what was typed', async () => {
        // The server is the one that decides what was stored, and a date it
        // refused to keep must not sit in the box looking saved.
        const view = await settings({
            answer: async (url, init) =>
                init?.method === 'PUT'
                    ? { status: 200, body: { ...filled, startDate: '' } }
                    : { status: 200, body: filled }
        });

        await view.el('profile').dispatch('submit');

        assert.equal(view.el('startDate').value, '');
    });

    test('a save says so without naming a field it may not have touched', async () => {
        // This form saves three things. Telling somebody who corrected a start
        // date that everyone can now see the new name sends them off to check
        // a name that has not changed.
        const view = await settings({ answer: async () => ({ status: 200, body: filled }) });

        await view.el('profile').dispatch('submit');

        assert.equal(view.text('said'), 'Settings saved.');
    });
});

describe('arming the delete button', () => {
    test('starts disabled, with the archive name shown to copy', async () => {
        const view = await settings({ answer: loaded(gone) });

        assert.equal(view.el('delete-go').disabled, true);
        assert.equal(view.text('confirm-slug'), SLUG);
    });

    test('stays disabled while the typed name is wrong', async () => {
        const view = await settings({ answer: loaded(gone) });

        view.el('confirm').value = 'elder.exampl';
        await view.el('confirm').dispatch('input');

        assert.equal(view.el('delete-go').disabled, true);
    });

    test('and while the box is empty, which is the state it is left in', async () => {
        const view = await settings({ answer: loaded(gone) });

        view.el('confirm').value = '';
        await view.el('confirm').dispatch('input');

        assert.equal(view.el('delete-go').disabled, true);
    });

    test('a stray space either side is the same intention', async () => {
        const view = await settings({ answer: loaded(gone) });

        view.el('confirm').value = `  ${SLUG} `;
        await view.el('confirm').dispatch('input');

        assert.equal(view.el('delete-go').disabled, false);
    });

    test('the wrong case is not', async () => {
        // Slugs are lowercase everywhere in this service. Accepting a
        // capitalised one here would be the only place that is not true, and
        // the point of the exercise is that somebody read what they typed.
        const view = await settings({ answer: loaded(gone) });

        view.el('confirm').value = 'Elder.Example';
        await view.el('confirm').dispatch('input');

        assert.equal(view.el('delete-go').disabled, true);
    });
});

describe('deleting', () => {
    test('sends the typed name for the server to check again', async () => {
        // The check that counts is the server's. A confirmation living only in
        // JavaScript is one a retried fetch never has to pass.
        const view = await settings({ answer: loaded(gone) });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.equal(deletes(view).length, 1);
        assert.equal(deletes(view)[0].url, `/api/site/${SLUG}`);
        assert.equal(deletes(view)[0].body.confirm, SLUG);
    });

    test('leaves for the root, and not by a route Back can undo', async () => {
        // The archive is the one page now guaranteed to refuse them, so going
        // back to it would end a deletion on a page saying they are not
        // allowed here.
        const view = await settings({ answer: loaded(gone) });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.equal(view.context.location.replaced, '/');
    });

    test('a server refusal is shown and the page stays put', async () => {
        const view = await settings({
            answer: loaded({ status: 400, body: { error: 'type the archive name to confirm' } })
        });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.equal(view.text('delete-said'), 'type the archive name to confirm');
        assert.equal(view.context.location.replaced, undefined);
    });

    test('and the button comes back, so a corrected attempt is possible', async () => {
        const view = await settings({
            answer: loaded({ status: 409, body: {} })
        });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.equal(view.el('delete-go').disabled, false);
    });

    test('a network failure says plainly that nothing was deleted', async () => {
        // The one message on this page somebody will read twice. "Could not
        // reach the server" alone leaves them wondering whether it went
        // through.
        const view = await settings({
            answer: async (url, init) => {
                if (init?.method === 'DELETE') throw new Error('offline');
                return { status: 200, body: PROFILE };
            }
        });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.match(view.text('delete-said'), /nothing was deleted/i);
        assert.equal(view.context.location.replaced, undefined);
    });

    test('an expired session goes through the chooser, not straight to a provider', async () => {
        const view = await settings({ answer: loaded({ status: 401, body: {} }) });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.match(view.context.location.href, /^\/login\.html\?/);
        assert.match(view.context.location.href, /settings/);
    });
});

describe('who sees the control at all', () => {
    test('a reader is told to go away before any of it renders', async () => {
        const view = await settings({ answer: async () => ({ status: 403, body: {} }) });

        assert.equal(view.el('everything').hidden, true);
        assert.match(view.text('state'), /owners/i);
    });
});

// Deleting somebody else's archive is the same form with one more field in it.
// What is checked here is that the field appears for the right person, that it
// is the second thing the button waits on, and that an owner is left with the
// form they had before.
describe('an operator at the delete control', () => {
    const asOperator = (deleteAnswer) => async (url, init) =>
        init?.method === 'DELETE' ? deleteAnswer : { status: 200, body: { ...PROFILE, viaOperator: true } };

    test('is told whose archive this is, and asked why', async () => {
        const view = await settings({ answer: asOperator(gone) });

        assert.equal(view.el('delete-operator').hidden, false);
        assert.equal(view.el('reason-row').hidden, false);
    });

    test('the button waits for the reason as well as the name', async () => {
        const view = await settings({ answer: asOperator(gone) });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');

        assert.equal(view.el('delete-go').disabled, true);
    });

    test('and for the name as well as the reason', async () => {
        const view = await settings({ answer: asOperator(gone) });

        view.el('reason').value = 'abuse report #14';
        await view.el('reason').dispatch('input');

        assert.equal(view.el('delete-go').disabled, true);
    });

    test('whitespace does not arm it', async () => {
        const view = await settings({ answer: asOperator(gone) });

        view.el('confirm').value = SLUG;
        view.el('reason').value = '   ';
        await view.el('reason').dispatch('input');

        assert.equal(view.el('delete-go').disabled, true);
    });

    test('both filled in sends both', async () => {
        const view = await settings({ answer: asOperator(gone) });

        view.el('confirm').value = SLUG;
        view.el('reason').value = '  abuse report #14  ';
        await view.el('reason').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.equal(deletes(view)[0].body.confirm, SLUG);
        assert.equal(deletes(view)[0].body.reason, 'abuse report #14');
    });

    test('an owner is shown neither the warning nor the box', async () => {
        // A field that fires when nothing is wrong is the one people learn to
        // fill in without reading, and a family leaving is not asked to
        // justify itself.
        const view = await settings({ answer: loaded(gone) });

        assert.equal(view.el('delete-operator').hidden, true);
        assert.equal(view.el('reason-row').hidden, true);
    });

    test('and their request carries an empty reason rather than none', async () => {
        // The browser does not decide which rule it is subject to. It sends
        // what the box holds and the server decides whether that is enough.
        const view = await settings({ answer: loaded(gone) });

        view.el('confirm').value = SLUG;
        await view.el('confirm').dispatch('input');
        await view.el('delete').dispatch('submit');

        assert.equal(deletes(view)[0].body.reason, '');
    });
});
