// The people page: who can read one archive, and the controls to change it.
//
// Everything drawn here is decided by the server. `removable` arrives on each
// row already computed, and the buttons are drawn from it rather than from any
// rule restated in this file -- a second copy of the policy would drift, and it
// would drift in the direction of offering a button that then fails. The API
// re-checks all of it on every call regardless; this decides what to draw, not
// who is allowed to do it.

(() => {
    'use strict';

    // `/people/<slug>`. Read from the path rather than a query string so the
    // page has the same shape as the archive it belongs to.
    const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '');

    const $ = (id) => document.getElementById(id);
    const state = $('state');

    const show = (message) => {
        state.textContent = message;
        state.hidden = false;
        $('everything').hidden = true;
    };

    const api = (path, init) =>
        fetch(`/api/members/${encodeURIComponent(slug)}${path}`, {
            cache: 'no-store',
            ...init
        });

    // Kept out of the markup. Every one of these strings is either an address
    // somebody typed or a name somebody typed, so nothing here builds HTML.
    function row(person) {
        const item = document.createElement('li');
        item.className = 'people__row';

        const who = document.createElement('span');
        who.className = 'people__who';
        who.textContent = person.email;
        item.appendChild(who);

        const what = document.createElement('span');
        what.className = 'people__what';
        what.textContent = person.pending
            ? `invited as ${person.role}`
            : person.verifiedMissionary
              ? 'the missionary'
              : person.role;
        item.appendChild(what);

        const controls = document.createElement('span');
        controls.className = 'people__controls';

        if (!person.pending && person.removable) {
            controls.appendChild(
                button(person.role === 'owner' ? 'Make reader' : 'Make owner', async () => {
                    await api(`/${encodeURIComponent(person.email)}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role: person.role === 'owner' ? 'reader' : 'owner' })
                    });
                })
            );
        }

        if (person.pending || person.removable) {
            controls.appendChild(
                button('Remove', async () => {
                    // The one destructive control on the page, and the one
                    // whose consequence is invisible: the person is simply
                    // gone the next time they look.
                    const sure = person.pending
                        ? `Withdraw the invitation to ${person.email}?`
                        : `Remove ${person.email} from this archive?\n\nThey will no longer be able to read the letters. Nothing is emailed to them.`;
                    if (!window.confirm(sure)) return 'cancelled';
                    await api(`/${encodeURIComponent(person.pending ? person.id : person.email)}`, {
                        method: 'DELETE'
                    });
                })
            );
        } else if (!person.pending) {
            const why = document.createElement('span');
            why.className = 'note';
            // Said rather than left blank. A row with no buttons next to rows
            // that have them reads as a bug.
            why.textContent = person.you
                ? 'this is you'
                : 'verified, cannot be removed';
            controls.appendChild(why);
        }

        item.appendChild(controls);
        return item;
    }

    function button(label, action) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'button button--quiet button--compact';
        el.textContent = label;
        el.addEventListener('click', async () => {
            el.disabled = true;
            try {
                if ((await action()) === 'cancelled') {
                    el.disabled = false;
                    return;
                }
            } catch {
                el.disabled = false;
                return;
            }
            await load();
        });
        return el;
    }

    async function load() {
        let response;
        try {
            response = await api('');
        } catch {
            show('Could not load this page. Please try again.');
            return;
        }

        if (response.status === 401) {
            location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return;
        }
        if (response.status === 403) {
            show('Only owners can see who has access to an archive.');
            return;
        }
        if (!response.ok) {
            show('This archive is not available to you.');
            return;
        }

        const payload = await response.json();
        const list = $('people');
        list.textContent = '';

        for (const person of payload.members) list.appendChild(row(person));
        // Invitations after members, and marked, because an invitation is an
        // offer rather than access and the difference has to be visible.
        for (const invited of payload.invites) list.appendChild(row({ ...invited, pending: true }));

        state.hidden = true;
        $('everything').hidden = false;
    }

    async function invite(event) {
        event.preventDefault();
        const said = $('invite-said');
        $('invite-submit').disabled = true;
        said.textContent = '';

        let response;
        try {
            response = await api('', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: $('email').value, role: $('role').value })
            });
        } catch {
            said.textContent = 'That did not go through. Please try again.';
            $('invite-submit').disabled = false;
            return;
        }

        const body = await response.json().catch(() => ({}));
        $('invite-submit').disabled = false;

        if (!response.ok) {
            // The server's own words. Every refusal it produces is already a
            // sentence written for the person reading it, and translating them
            // here would mean maintaining the same list twice.
            said.textContent = body.error ?? 'That did not go through.';
            return;
        }

        // Deliberately does not claim the mail arrived. It has been handed to
        // the provider, which is a different thing, and telling somebody their
        // invitation was delivered when it went to spam sends them looking in
        // the wrong place.
        said.textContent = `Invitation sent to ${body.email}. It works for two weeks.`;
        $('email').value = '';
        await load();
    }

    if (!slug) {
        show('No archive was named.');
    } else {
        $('back').href = `/${encodeURIComponent(slug)}/`;
        $('invite').addEventListener('submit', invite);
        load();
    }
})();
