// The settings page: what one archive is called, and when it ends.
//
// Small on purpose. The only reason it exists is that the display name used to
// be whatever the claimant typed in their first thirty seconds, with no way to
// change it -- and that name is on every page, on the tab, on the archive list,
// and in the subject line of every invitation the owner sends.

(() => {
    'use strict';

    // `/settings/<slug>`, read from the path so the page has the same shape as
    // the archive it belongs to and as `/people/<slug>` beside it.
    const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '');

    const $ = (id) => document.getElementById(id);
    const state = $('state');

    const show = (message) => {
        state.textContent = message;
        state.hidden = false;
        $('everything').hidden = true;
    };

    const api = (init) =>
        fetch(`/api/profile/${encodeURIComponent(slug)}`, { cache: 'no-store', ...init });

    // Every refusal this page can meet, handled once. Shared by the load and
    // the save so the two cannot disagree about what a 403 means.
    function refused(response) {
        if (response.status === 401) {
            // Through the chooser, never straight at a provider. There are two
            // now, and sending a Google owner to Microsoft strands them on an
            // account that has never heard of this archive -- with a page that
            // then tells them, correctly and uselessly, that they are not the
            // owner.
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return true;
        }
        if (response.status === 403) {
            show('Only owners can change an archive\u2019s settings.');
            return true;
        }
        return false;
    }

    async function load() {
        let response;
        try {
            response = await api();
        } catch {
            show('Could not load this page. Please try again.');
            return;
        }

        if (refused(response)) return;
        if (!response.ok) {
            show('This archive is not available to you.');
            return;
        }

        const payload = await response.json();
        $('displayName').value = payload.displayName ?? '';
        $('returnDate').value = payload.returnDate ?? '';

        state.hidden = true;
        $('everything').hidden = false;
    }

    async function save(event) {
        event.preventDefault();
        const said = $('said');
        const button = $('save');

        button.disabled = true;
        said.textContent = 'Saving\u2026';

        let response;
        try {
            response = await api({
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    displayName: $('displayName').value,
                    returnDate: $('returnDate').value
                })
            });
        } catch {
            button.disabled = false;
            said.textContent = 'Could not reach the server. Nothing was changed.';
            return;
        }

        if (refused(response)) return;

        const body = await response.json().catch(() => ({}));
        button.disabled = false;

        if (!response.ok) {
            // The server's own words. Each refusal it produces is already a
            // sentence written for the person reading it, and restating them
            // here would mean maintaining the same list twice.
            said.textContent = body.error ?? 'That did not save.';
            return;
        }

        // Redraws from the response rather than leaving what was typed. The
        // server trims and shortens, so the box should show what was actually
        // stored -- otherwise a name silently cut at sixty characters looks
        // saved in full until the next visit.
        $('displayName').value = body.displayName ?? '';
        $('returnDate').value = body.returnDate ?? '';
        said.textContent = 'Saved. Everyone reading the archive sees the new name.';
    }

    // --- deleting the archive ---------------------------------------------

    // The button stays disabled until the typed name matches exactly.
    //
    // The server checks this too, and that is the check that counts -- a
    // confirmation living only in JavaScript is one a retried fetch never has
    // to pass. This half exists because a disabled button is a better prompt
    // than an error is: it tells somebody who half-meant it that they have not
    // finished, without ever having accepted the request.
    function armed() {
        $('delete-go').disabled = $('confirm').value.trim() !== slug;
    }

    async function destroy(event) {
        event.preventDefault();
        const said = $('delete-said');
        const button = $('delete-go');

        button.disabled = true;
        said.textContent = 'Deleting\u2026';

        let response;
        try {
            response = await fetch(`/api/site/${encodeURIComponent(slug)}`, {
                method: 'DELETE',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: $('confirm').value.trim() })
            });
        } catch {
            armed();
            said.textContent = 'Could not reach the server. Nothing was deleted.';
            return;
        }

        if (refused(response)) return;

        if (!response.ok) {
            armed();
            const body = await response.json().catch(() => ({}));
            said.textContent = body.error ?? 'That did not work. Nothing was deleted.';
            return;
        }

        // To the root rather than back to the archive, which is the one place
        // that is now guaranteed to refuse them. Replaced rather than pushed,
        // so Back does not lead to a page about an archive that is gone.
        location.replace('/');
    }

    if (!slug) {
        show('No archive was named.');
    } else {
        $('back').href = `/${encodeURIComponent(slug)}/`;
        $('confirm-slug').textContent = slug;
        $('profile').addEventListener('submit', save);
        $('confirm').addEventListener('input', armed);
        $('delete').addEventListener('submit', destroy);
        load();
    }
})();
