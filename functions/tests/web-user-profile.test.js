import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const GOOGLE = {
    identityProvider: 'google',
    userId: 'google-id',
    userDetails: 'ana@example.com',
    claims: [
        { typ: 'name', val: 'Ana Example' },
        { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', val: 'Ana' },
        { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', val: 'Example' }
    ]
};

const open = async (principal = GOOGLE) => {
    const view = page({ html: 'index.html', path: '/' });
    const net = fetching((url, init) =>
        url === '/.auth/me'
            ? { status: 200, body: { clientPrincipal: principal } }
            : { status: 200, body: {} }
    );
    run(['user-profile.js'], { context: view.context, fetch: net.fetch });
    await settled();
    return { view, net };
};

describe('copying provider names into the application profile', () => {
    test('Google structured claims are preserved with the full name', async () => {
        const { net } = await open();
        const saved = net.calls.find((call) => call.url === '/api/profile');
        assert.equal(saved.method, 'PUT');
        assert.deepEqual(saved.body, {
            displayName: 'Ana Example',
            givenName: 'Ana',
            familyName: 'Example'
        });
    });

    test('Microsoft sends its full name without inventing components', async () => {
        const { net } = await open({
            identityProvider: 'aad',
            userId: 'aad-id',
            userDetails: 'ana@example.com',
            claims: [{ typ: 'name', val: 'Ana Example' }]
        });
        const saved = net.calls.find((call) => call.url === '/api/profile');
        assert.deepEqual(saved.body, {
            displayName: 'Ana Example',
            givenName: '',
            familyName: ''
        });
    });

    test('a provider response without a name creates no profile', async () => {
        const { net } = await open({
            identityProvider: 'aad',
            userId: 'aad-id',
            userDetails: 'ana@example.com',
            claims: []
        });
        assert.equal(net.calls.some((call) => call.url === '/api/profile'), false);
    });

    test('the masthead account menu appears without waiting for a cold profile sync', async () => {
        const view = page({ html: 'index.html', path: '/' });
        let finishProfile;
        const fetch = async (url) => {
            if (url === '/.auth/me') {
                return { ok: true, status: 200, json: async () => ({ clientPrincipal: GOOGLE }) };
            }
            if (url === '/api/profile') {
                return new Promise((resolve) => { finishProfile = resolve; });
            }
            return { ok: true, status: 200, json: async () => ({ memberships: [] }) };
        };
        run(['user-profile.js', 'account.js'], { context: view.context, fetch });
        await settled();

        assert.equal(view.context.document.getElementById('signed-out').hidden, true);
        assert.equal(view.context.document.getElementById('menu').hidden, false);
        assert.equal(view.context.document.getElementById('account-email').textContent, 'Ana Example');
        finishProfile?.({ ok: true, status: 200, json: async () => ({}) });
    });
});
