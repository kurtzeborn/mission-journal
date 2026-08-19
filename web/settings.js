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

    // Whether the authority to be on this page came from the operator setting
    // rather than from the archive's own member list. It changes one control:
    // deleting somebody else's archive requires a reason, and deleting your
    // own does not. Set once from the load and never re-read, because a
    // membership that changed underneath would have to change the answer to
    // "may you be here at all" first, and that is what the next request asks.
    let asOperator = false;

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
        $('mission').value = payload.mission ?? '';
        $('startDate').value = payload.startDate ?? '';
        $('returnDate').value = payload.returnDate ?? '';

        asOperator = Boolean(payload.viaOperator);
        $('delete-operator').hidden = !asOperator;
        $('reason-row').hidden = !asOperator;

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
                    mission: $('mission').value,
                    startDate: $('startDate').value,
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
        $('mission').value = body.mission ?? '';
        $('startDate').value = body.startDate ?? '';
        $('returnDate').value = body.returnDate ?? '';
        // Says nothing about which field changed, because this one form now
        // saves four of them and naming the wrong one is worse than naming
        // none. Somebody who has just corrected a start date and is told the
        // archive's name has changed has to go and check that it has not.
        said.textContent = 'Settings saved.';
    }

    // --- deleting the archive ---------------------------------------------

    // The button stays disabled until the typed name matches exactly -- and,
    // for an operator, until they have said why.
    //
    // The server checks both, and those are the checks that count -- a
    // confirmation living only in JavaScript is one a retried fetch never has
    // to pass. This half exists because a disabled button is a better prompt
    // than an error is: it tells somebody who half-meant it that they have not
    // finished, without ever having accepted the request.
    function armed() {
        const named = $('confirm').value.trim() === slug;
        const explained = !asOperator || Boolean($('reason').value.trim());
        $('delete-go').disabled = !named || !explained;
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
                // Sent whatever the box holds. An owner's is empty and the
                // server neither asks for nor needs it; branching here on
                // `asOperator` would mean the browser deciding which rule it
                // is subject to, which is the server's decision.
                body: JSON.stringify({
                    confirm: $('confirm').value.trim(),
                    reason: $('reason').value.trim()
                })
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
        $('reason').addEventListener('input', armed);
        $('delete').addEventListener('submit', destroy);
        load();
    }
})();
