// The trip back in after the platform's session has run out.
//
// The session is short, its length is not published and not ours to set, so
// the thing worth testing is not how long anyone stays signed in but how much
// they have to do about it. Google and Microsoft keep their own sessions for
// months; the only thing this page ever lacked was which of the two to ask.
//
// Everything here is therefore about one question: when does it go straight
// through, and when does it stop and ask? Getting that wrong in the generous
// direction is a redirect loop, and in the mean direction it signs somebody
// back into the account they just walked away from.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { page, run } from './web-dom.js';

const SLUG = '/isaac.backman';

/** The chooser as the platform serves it -- in place of the page that 401'd. */
function chooser({ path = SLUG, search = '', remembered = null, context = null } = {}) {
    const view = context ? { context } : page({ html: 'login.html', path, search });
    if (remembered) view.context.localStorage.setItem('mj.provider', remembered);
    run(['login.js'], { context: view.context });
    return view;
}

const wentTo = (view) => view.context.location.replaced ?? null;

describe('coming back after the session has gone', () => {
    test('the first time, it asks', async () => {
        // Nobody has chosen yet, so there is nothing to be silent about.
        const view = chooser();

        assert.equal(wentTo(view), null);
        assert.match(view.el('signin-google').href, /^\/\.auth\/login\/google\?/);
        assert.match(view.el('signin-aad').href, /^\/\.auth\/login\/aad\?/);
    });

    test('choosing is what gets remembered, not signing in', async () => {
        // The button is the last honest signal. Whether the provider then says
        // yes is between them and the visitor, and a sign-in that failed is
        // still a sign-in that was attempted with that provider.
        const view = chooser();
        await view.el('signin-google').dispatch('click');

        assert.equal(view.context.localStorage.getItem('mj.provider'), 'google');
    });

    test('the next time, it does not ask', async () => {
        const view = chooser({ remembered: 'google' });

        assert.match(wentTo(view), /^\/\.auth\/login\/google\?/);
    });

    test('and it still lands on the letter that was asked for', async () => {
        // The whole point of the rewrite: the address bar keeps the deep link,
        // so the silent return has to carry it the same as a button would.
        const view = chooser({ remembered: 'aad' });

        assert.match(wentTo(view), new RegExp(`post_login_redirect_uri=${encodeURIComponent(SLUG)}$`));
    });

    test('it goes out replacing rather than adding to history', async () => {
        // Otherwise Back from the letter lands here, and here throws them
        // forward again -- a page that cannot be left by the ordinary means.
        const view = chooser({ remembered: 'google' });

        assert.equal(view.context.location.replaced, view.context.location.href);
    });

    test('a destination is only tried silently once', async () => {
        // A trip out that comes back still unauthenticated meets the same 401
        // and would go straight out again. The second time, ask.
        const view = chooser({ remembered: 'google' });
        assert.ok(wentTo(view));

        view.context.location.replaced = null;
        chooser({ context: view.context });

        assert.equal(wentTo(view), null);
    });

    test('a different letter is a different destination', async () => {
        // One bad archive must not cost every other archive its silent return.
        const first = chooser({ remembered: 'google' });
        first.context.location.replaced = null;
        first.context.location.pathname = '/mallory.kurtzeborn';

        chooser({ context: first.context });

        assert.match(wentTo(first), /mallory\.kurtzeborn$/);
    });

    test('signing out means it', async () => {
        // Remembered, the next archive they opened would send them silently
        // back to the account they just left, which is the exact opposite of
        // what "sign out and try another account" offers.
        const view = chooser({ path: '/login.html', search: '?signedout=1', remembered: 'google' });

        assert.equal(wentTo(view), null);
        assert.equal(view.context.localStorage.getItem('mj.provider'), null);
    });

    test('a remembered name nobody recognises is ignored', async () => {
        // It is read back out of a store the visitor can edit, and the only
        // safe reading of an unknown value is that nothing was remembered.
        const view = chooser({ remembered: 'github' });

        assert.equal(wentTo(view), null);
        assert.equal(view.el('signin-google').hidden, false);
    });
});
