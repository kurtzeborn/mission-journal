// What the people page actually says, driven through the real script.
//
// The interesting cases are all refusals. Inviting twelve relatives at once
// means twelve chances for one of them to be a typo, and the difference
// between a page that says "3 failed" and one that names them is the
// difference between fixing it and pasting the whole list again.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const SLUG = 'elder.example';

const OWNER_ONLY = {
    members: [{ email: 'mum@example.com', role: 'owner', you: true, removable: false, invitedEmail: '' }],
    invites: []
};

/** A page with the script loaded and its first render finished. */
async function people({ answer }) {
    const view = page({ html: 'people.html', path: `/people/${SLUG}` });
    const net = fetching(answer);
    run('people.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

const listing = (payload) => async (url, init) =>
    init?.method === 'POST' ? { status: 200, body: {} } : { status: 200, body: payload };

describe('inviting a whole family in one sitting', () => {
    test('one address per invitation, however they were pasted', async () => {
        const view = await people({ answer: listing(OWNER_ONLY) });

        // The three shapes people actually have: a comma-separated line out of
        // an old email, a name-and-address pair from a mail client, and a
        // column copied from a spreadsheet.
        view.el('email').value =
            'grandma@example.com, uncle.bob@example.com\nAunt Kay <kay@example.com>\n\n  cousin@example.com  ';
        view.el('role').value = 'reader';
        await view.el('invite').dispatch('submit');

        const invited = view.calls.filter((c) => c.method === 'POST').map((c) => c.body.email);
        assert.deepEqual(invited, [
            'grandma@example.com',
            'uncle.bob@example.com',
            'kay@example.com',
            'cousin@example.com'
        ]);
        assert.equal(view.text('invite-said'), '4 invitations sent. They work for two weeks.');
        assert.equal(view.el('email').value, '');
    });

    test('the same relative listed twice is only invited once', async () => {
        // Duplicates are the norm in a pasted list, and every one of them would
        // otherwise spend one of the day's twenty invitations to be refused.
        const view = await people({ answer: listing(OWNER_ONLY) });

        view.el('email').value = 'gran@example.com, Gran <GRAN@example.com>; gran@example.com';
        await view.el('invite').dispatch('submit');

        const invited = view.calls.filter((c) => c.method === 'POST').map((c) => c.body.email);
        assert.deepEqual(invited, ['gran@example.com']);
        assert.equal(view.text('invite-said'), 'Invitation sent. It works for two weeks.');
    });

    test('nothing recognisable means nothing is sent', async () => {
        const view = await people({ answer: listing(OWNER_ONLY) });

        view.el('email').value = '  ,  ;\n\n ';
        await view.el('invite').dispatch('submit');

        assert.equal(view.calls.filter((c) => c.method === 'POST').length, 0);
        assert.equal(view.text('invite-said'), 'No email addresses found in that.');
    });

    test('every refusal is named, in the words the server used', async () => {
        const view = await people({
            answer: async (url, init) => {
                if (init?.method !== 'POST') return { status: 200, body: OWNER_ONLY };
                const email = JSON.parse(init.body).email;
                if (email === 'nope') return { status: 400, body: { error: 'not an email address' } };
                if (email === 'mum@example.com') return { status: 400, body: { error: 'already a member' } };
                return { status: 200, body: {} };
            }
        });

        view.el('email').value = 'ok@example.com, nope, mum@example.com';
        await view.el('invite').dispatch('submit');

        assert.equal(view.text('invite-said'), 'Invitation sent. It works for two weeks.');
        assert.deepEqual(view.lines('invite-trouble'), [
            'nope — not an email address',
            'mum@example.com — already a member'
        ]);
        assert.equal(view.el('invite-trouble').hidden, false);
    });

    test('the ones that failed are left in the box to be fixed', async () => {
        // Clearing the box on a partial success throws away exactly the
        // addresses that still need an invitation.
        const view = await people({
            answer: async (url, init) => {
                if (init?.method !== 'POST') return { status: 200, body: OWNER_ONLY };
                return JSON.parse(init.body).email.startsWith('bad')
                    ? { status: 400, body: { error: 'not an email address' } }
                    : { status: 200, body: {} };
            }
        });

        view.el('email').value = 'good@example.com, bad-one@x, bad-two@y';
        await view.el('invite').dispatch('submit');

        assert.equal(view.el('email').value, 'bad-one@x\nbad-two@y');
    });

    test('hitting the daily cap says so, and says which ones missed out', async () => {
        // The cap is the one refusal an ordinary family can trip by doing
        // nothing wrong, so it has to arrive as an explanation rather than a
        // failure.
        let allowed = 2;
        const view = await people({
            answer: async (url, init) => {
                if (init?.method !== 'POST') return { status: 200, body: OWNER_ONLY };
                if (allowed-- > 0) return { status: 200, body: {} };
                return { status: 429, body: { error: 'too many invitations today, try again tomorrow' } };
            }
        });

        view.el('email').value = 'a@example.com\nb@example.com\nc@example.com';
        await view.el('invite').dispatch('submit');

        assert.equal(view.text('invite-said'), '2 invitations sent. They work for two weeks.');
        assert.deepEqual(view.lines('invite-trouble'), [
            'c@example.com — too many invitations today, try again tomorrow'
        ]);
    });

    test('the network dropping mid-list does not lose the rest of it', async () => {
        const view = await people({
            answer: async (url, init) => {
                if (init?.method !== 'POST') return { status: 200, body: OWNER_ONLY };
                return JSON.parse(init.body).email === 'b@example.com'
                    ? new Error('offline')
                    : { status: 200, body: {} };
            }
        });

        view.el('email').value = 'a@example.com, b@example.com, c@example.com';
        await view.el('invite').dispatch('submit');

        const invited = view.calls.filter((c) => c.method === 'POST').map((c) => c.body.email);
        assert.deepEqual(invited, ['a@example.com', 'b@example.com', 'c@example.com']);
        assert.deepEqual(view.lines('invite-trouble'), ['b@example.com — could not reach the server']);
        // Left ready to retry, and only that one.
        assert.equal(view.el('email').value, 'b@example.com');
    });

    test('the send button comes back even when everything failed', async () => {
        const view = await people({
            answer: async (url, init) =>
                init?.method === 'POST'
                    ? { status: 400, body: { error: 'not an email address' } }
                    : { status: 200, body: OWNER_ONLY }
        });

        view.el('email').value = 'x@example.com';
        await view.el('invite').dispatch('submit');

        assert.equal(view.el('invite-submit').disabled, false);
        assert.equal(view.text('invite-said'), 'Nothing was sent.');
    });
});

describe('reading the list of who has access', () => {
    test('an unfamiliar address is shown next to the one it was invited as', async () => {
        const view = await people({
            answer: listing({
                members: [
                    { email: 'mum@example.com', role: 'owner', you: true, removable: false, invitedEmail: '' },
                    {
                        email: 'g.example@gmail.com',
                        role: 'reader',
                        removable: true,
                        invitedEmail: 'grandma@aol.com'
                    }
                ],
                invites: []
            })
        });

        const rows = view.lines('people');
        assert.match(rows[1], /g\.example@gmail\.com/);
        assert.match(rows[1], /invited as grandma@aol\.com/);
        // And the one that never changed says it once.
        assert.doesNotMatch(rows[0], /invited as/);
    });

    test('a pending invitation is marked as an offer, not as access', async () => {
        const view = await people({
            answer: listing({
                members: OWNER_ONLY.members,
                invites: [{ id: 'abc', email: 'later@example.com', role: 'reader' }]
            })
        });

        assert.match(view.lines('people')[1], /invited as reader/);
    });

    test('a reader who reaches the page is told why it is empty', async () => {
        const view = await people({ answer: async () => ({ status: 403, body: {} }) });

        assert.equal(view.text('state'), 'Only owners can see who has access to an archive.');
        assert.equal(view.el('everything').hidden, true);
    });

    test('withdrawing an invitation asks first, and asks about the invitation', async () => {
        // Removing a member and withdrawing an offer read the same on screen
        // and are not the same act. The confirmation is the only place the
        // difference is stated.
        const view = await people({
            answer: listing({
                members: OWNER_ONLY.members,
                invites: [{ id: 'abc', email: 'later@example.com', role: 'reader' }]
            })
        });

        view.context.confirmed = false;
        await view.button('people', 'Remove').dispatch('click');

        assert.equal(view.calls.filter((c) => c.method === 'DELETE').length, 0);
    });

    test('a withdrawal is addressed by invitation, never by email', async () => {
        // The invites table is keyed by token hash. Sending the address would
        // delete nothing, silently.
        const view = await people({
            answer: listing({
                members: OWNER_ONLY.members,
                invites: [{ id: 'the-hash', email: 'later@example.com', role: 'reader' }]
            })
        });

        await view.button('people', 'Remove').dispatch('click');

        const deleted = view.calls.find((c) => c.method === 'DELETE');
        assert.equal(deleted.url, `/api/members/${SLUG}/the-hash`);
    });
});

describe('sending an invitation again', () => {
    const WAITING = {
        members: OWNER_ONLY.members,
        invites: [{ id: 'the-hash', email: 'later@example.com', role: 'reader' }]
    };

    test('the button is offered on invitations and on nobody else', async () => {
        const view = await people({
            answer: listing({
                members: [
                    ...OWNER_ONLY.members,
                    { email: 'reader@example.com', role: 'reader', removable: true, invitedEmail: '' }
                ],
                invites: WAITING.invites
            })
        });

        const rows = view.lines('people');
        assert.doesNotMatch(rows[0], /Resend/);
        assert.doesNotMatch(rows[1], /Resend/);
        assert.match(rows[2], /Resend/);
    });

    test('it names the invitation, not the address', async () => {
        // Same reason withdrawal does: the invites table is keyed by token
        // hash, and an address would match nothing.
        const view = await people({ answer: listing(WAITING) });

        await view.button('people', 'Resend').dispatch('click');

        const sent = view.calls.find((c) => c.url.endsWith('/resend'));
        assert.equal(sent.method, 'POST');
        assert.equal(sent.url, `/api/members/${SLUG}/the-hash/resend`);
    });

    test('it does not ask first', async () => {
        // The cost of a misfire is one duplicate email to somebody already
        // being invited. A dialog in front of that is worse than the mistake.
        const view = await people({ answer: listing(WAITING) });

        view.context.confirmed = false;
        await view.button('people', 'Resend').dispatch('click');

        assert.ok(view.calls.some((c) => c.url.endsWith('/resend')));
    });

    test('a refusal is said out loud, next to the row it belongs to', async () => {
        // The failure this replaces: the button re-enabled itself, the list
        // reloaded unchanged, and nothing on the page explained why. An owner
        // presses it again, and again.
        const view = await people({
            answer: async (url, init) =>
                url.endsWith('/resend')
                    ? { status: 429, body: { error: 'too many invitations today, try again tomorrow' } }
                    : { status: 200, body: WAITING }
        });

        await view.button('people', 'Resend').dispatch('click');
        await settled();

        assert.match(view.lines('people')[1], /too many invitations today/);
    });

    test('and the button comes back so it can be tried tomorrow', async () => {
        const view = await people({
            answer: async (url) =>
                url.endsWith('/resend')
                    ? { status: 429, body: { error: 'too many invitations today, try again tomorrow' } }
                    : { status: 200, body: WAITING }
        });

        await view.button('people', 'Resend').dispatch('click');
        await settled();

        assert.equal(view.button('people', 'Resend').disabled, false);
    });

    test('a refusal the owner cannot act on links to the answer', async () => {
        // The opt-out is the one refusal an owner cannot fix and did not
        // cause, so "has asked us not to email them" reads like our bug
        // rather than the recipient's choice. The link is the whole reason
        // the questions page is anchored instead of collapsed.
        const view = await people({
            answer: async (url) =>
                url.endsWith('/resend')
                    ? { status: 403, body: { error: 'has asked us not to email them' } }
                    : { status: 200, body: WAITING }
        });

        await view.button('people', 'Resend').dispatch('click');
        await settled();

        assert.match(view.lines('people')[1], /has asked us not to email them/);
        assert.equal(view.link('people', 'Why?').href, '/faq#stop-emails');
    });

    test('the network dropping is reported rather than swallowed', async () => {
        const view = await people({
            answer: async (url) => (url.endsWith('/resend') ? new Error('offline') : { status: 200, body: WAITING })
        });

        await view.button('people', 'Resend').dispatch('click');
        await settled();

        assert.match(view.lines('people')[1], /could not reach the server/);
    });

    test('success reloads the list rather than claiming anything', async () => {
        // There is nothing honest to say. The mail has been handed to a
        // provider, which is not the same as arriving, and the row is already
        // where the owner is looking.
        const view = await people({ answer: listing(WAITING) });
        const before = view.calls.filter((c) => c.method === 'GET').length;

        await view.button('people', 'Resend').dispatch('click');
        await settled();

        assert.equal(view.calls.filter((c) => c.method === 'GET').length, before + 1);
        assert.doesNotMatch(view.lines('people')[1], /could not/);
    });
});

describe('showing that somebody is not getting their mail', () => {
    // The last line of the resend suite is the reason this exists: success
    // reloads and claims nothing, because handing mail to a provider is not
    // arriving. This is where "and it did not arrive" eventually shows up.
    const undeliverable = (delivery) =>
        listing({
            members: [
                ...OWNER_ONLY.members,
                { email: 'gran@example.com', role: 'reader', removable: true, invitedEmail: '', delivery }
            ],
            invites: []
        });

    const classesOn = (view, i) => view.el('people').children[i].classList.added;

    test('the row is dimmed and says why, in words nobody has to look up', async () => {
        const view = await people({ answer: undeliverable('failed') });

        assert.ok(classesOn(view, 1).includes('people__row--undelivered'));
        assert.match(view.lines('people')[1], /Mail is not reaching this address/);
        assert.match(view.lines('people')[1], /Check the spelling/);
    });

    test('one sentence, whatever the provider called it', async () => {
        // The three-way split came out again: we cannot reliably tell a
        // suppression from a bounce over this API, and the owner's remedy is
        // the same either way.
        const bounced = await people({ answer: undeliverable('bounced') });
        const failed = await people({ answer: undeliverable('failed') });

        assert.equal(bounced.lines('people')[1], failed.lines('people')[1]);
    });

    test('everybody else looks exactly as they did', async () => {
        const view = await people({ answer: undeliverable('bounced') });

        assert.deepEqual(classesOn(view, 0), []);
        assert.doesNotMatch(view.lines('people')[0], /not reaching/);
    });

    test('a healthy list is unmarked from top to bottom', async () => {
        const view = await people({ answer: listing(OWNER_ONLY) });

        assert.deepEqual(classesOn(view, 0), []);
    });
});
