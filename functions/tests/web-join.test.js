// What a person sees after scanning an in-person QR invitation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

async function join({ answer, hash = '#display-code', storedReady, joinAfterSignIn }) {
    const view = page({ html: 'join.html', path: '/join', hash });
    if (storedReady) {
        view.context.sessionStorage.setItem('qr-invite-ready', JSON.stringify(storedReady));
    }
    if (joinAfterSignIn) {
        view.context.sessionStorage.setItem('qr-invite-join-after-signin', joinAfterSignIn);
    }
    const net = fetching(answer);
    run(['page.js', 'join.js'], { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

const ready = {
    status: 'ready',
    ticket: 'one-time-ticket',
    invitedBy: 'parent@example.com',
    missionary: 'Elder Example'
};

describe('opening a scanned invitation', () => {
    test('exchanges the display code before asking for sign-in', async () => {
        const view = await join({
            answer: async (url) =>
                url === '/api/qr-invite/exchange'
                    ? { body: ready }
                    : { body: { clientPrincipal: null } }
        });

        assert.equal(view.calls[0].url, '/api/qr-invite/exchange');
        assert.deepEqual(view.calls[0].body, { token: 'display-code' });
        assert.equal(view.context.location.hash, '');
        assert.match(view.text('ready-lede'), /parent@example\.com/);
        assert.equal(view.el('signin-block').hidden, false);
        assert.match(view.source, /Join with Microsoft/);
        assert.match(view.source, /Join with Google/);
    });

    test('a refreshed code tells the person to scan the current one', async () => {
        const view = await join({
            answer: async (url) =>
                url === '/api/qr-invite/exchange'
                    ? { body: { status: 'expired' } }
                    : { body: {} }
        });

        assert.equal(view.text('failed-title'), 'This QR code has refreshed');
        assert.match(view.text('failed-help'), /Scan the current code/);
    });

    test('stores the exchanged ticket across the sign-in round trip', async () => {
        const first = await join({
            answer: async (url) =>
                url === '/api/qr-invite/exchange'
                    ? { body: ready }
                    : { body: { clientPrincipal: null } }
        });

        assert.ok(first.context.sessionStorage.getItem('qr-invite-ready'));
    });

    test('clicking a join provider records consent for the return from sign-in', async () => {
        const view = await join({
            answer: async (url) =>
                url === '/api/qr-invite/exchange'
                    ? { body: ready }
                    : { body: { clientPrincipal: null } }
        });

        await view.el('signin-google').dispatch('click');

        assert.equal(
            view.context.sessionStorage.getItem('qr-invite-join-after-signin'),
            ready.ticket
        );
    });
});

describe('accepting the invitation', () => {
    test('adds the signed-in account and enters the archive', async () => {
        const view = await join({
            answer: async (url) => {
                if (url === '/api/qr-invite/exchange') return { body: ready };
                if (url === '/.auth/me') return { body: { clientPrincipal: { userDetails: 'reader@example.com' } } };
                if (url === '/api/qr-invite/accept') return { body: { status: 'ok', slug: 'elder.example' } };
                return { status: 404, body: {} };
            }
        });

        await view.el('accept-form').dispatch('submit');
        await settled();

        const accepted = view.calls.find((call) => call.url === '/api/qr-invite/accept');
        assert.deepEqual(accepted.body, { ticket: 'one-time-ticket' });
        assert.equal(view.context.location.href, '/elder.example/');
    });

    test('accepts automatically after the visitor already chose a join provider', async () => {
        const view = await join({
            hash: '',
            storedReady: ready,
            joinAfterSignIn: ready.ticket,
            answer: async (url) => {
                if (url === '/.auth/me') return { body: { clientPrincipal: { userDetails: 'reader@example.com' } } };
                if (url === '/api/qr-invite/accept') return { body: { status: 'ok', slug: 'elder.example' } };
                return { status: 404, body: {} };
            }
        });

        const accepted = view.calls.find((call) => call.url === '/api/qr-invite/accept');
        assert.deepEqual(accepted.body, { ticket: 'one-time-ticket' });
        assert.equal(view.context.location.href, '/elder.example/');
        assert.equal(view.context.sessionStorage.getItem('qr-invite-join-after-signin'), null);
    });

    test('still asks an already signed-in visitor to confirm', async () => {
        const view = await join({
            answer: async (url) => {
                if (url === '/api/qr-invite/exchange') return { body: ready };
                if (url === '/.auth/me') return { body: { clientPrincipal: { userDetails: 'reader@example.com' } } };
                return { status: 404, body: {} };
            }
        });

        assert.equal(view.el('accept-form').hidden, false);
        assert.equal(view.calls.some((call) => call.url === '/api/qr-invite/accept'), false);
    });

    test('does not ask again when sign-in expires after confirmation', async () => {
        const view = await join({
            answer: async (url) => {
                if (url === '/api/qr-invite/exchange') return { body: ready };
                if (url === '/.auth/me') return { body: { clientPrincipal: { userDetails: 'reader@example.com' } } };
                if (url === '/api/qr-invite/accept') {
                    return { status: 401, body: { status: 'unauthenticated' } };
                }
                return { status: 404, body: {} };
            }
        });

        await view.el('accept-form').dispatch('submit');
        await settled();

        assert.equal(
            view.context.sessionStorage.getItem('qr-invite-join-after-signin'),
            ready.ticket
        );
        assert.match(view.context.location.href, /^\/login\.html\?/);
    });

    test('a closed gathering is explained rather than looking broken', async () => {
        const view = await join({
            answer: async (url) => {
                if (url === '/api/qr-invite/exchange') return { body: ready };
                if (url === '/.auth/me') return { body: { clientPrincipal: { userDetails: 'reader@example.com' } } };
                if (url === '/api/qr-invite/accept') return { status: 409, body: { status: 'closed' } };
                return { status: 404, body: {} };
            }
        });

        await view.el('accept-form').dispatch('submit');
        await settled();

        assert.equal(view.text('failed-title'), 'These invitations have ended');
    });
});
