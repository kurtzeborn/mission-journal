// The operator's page: what has been deleted, and one door back.
//
// There is no owner-facing undo -- the confirmation on the settings page says
// the archive is gone and nothing here contradicts it -- so this page is the
// entire recovery path for a deletion somebody regrets. It is not linked from
// anywhere, and the API behind it refuses everyone not on OPERATOR_EMAILS with
// a 404, so a stranger who finds the URL sees the same "nothing here" as a
// stranger who mistypes one.

(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const state = $('state');
    const said = $('said');

    const show = (message) => {
        state.textContent = message;
        state.hidden = false;
        $('deletions').hidden = true;
    };

    // Dates are shown in the reader's own locale rather than as ISO strings.
    // The number that matters is how many days are left, and nobody counts
    // those off a timestamp.
    const day = (value) => {
        const when = new Date(value);
        return Number.isNaN(when.getTime())
            ? '\u2014'
            : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };

    // textContent everywhere below, never innerHTML. `reason` is free text an
    // owner typed into a form, and this is the only page that ever displays
    // it -- to the one account that can restore archives.
    const cell = (row, text) => {
        const td = document.createElement('td');
        td.textContent = text;
        row.appendChild(td);
        return td;
    };

    async function restore(slug, button) {
        // The archive is being handed back to a family who cannot see this
        // page, so there is nobody on the other end to notice a double click.
        button.disabled = true;
        said.textContent = `Restoring ${slug}\u2026`;

        let response;
        try {
            response = await fetch(`/api/manage/deletions/${encodeURIComponent(slug)}/restore`, {
                method: 'POST',
                cache: 'no-store'
            });
        } catch {
            said.textContent = 'Could not reach the server. Nothing was restored.';
            button.disabled = false;
            return;
        }

        if (response.ok) {
            said.textContent = `${slug} is back. Everyone who could read it can again.`;
            load();
            return;
        }

        // 409 is the one worth spelling out. Deleting an archive does not
        // reserve the name, so a forward can start a fresh site under it and a
        // different family can claim that -- and putting the old member list
        // back would hand strangers access to their letters.
        said.textContent =
            response.status === 409
                ? `${slug} belongs to somebody else now. It cannot be restored under that name.`
                : `Could not restore ${slug}. Nothing was changed.`;
        button.disabled = false;
    }

    function draw(deletions) {
        const rows = $('rows');
        rows.replaceChildren();

        for (const deletion of deletions) {
            const row = document.createElement('tr');
            cell(row, deletion.slug);
            cell(row, day(deletion.deletedAt));
            cell(row, deletion.deletedBy ?? '\u2014');
            cell(row, deletion.reason || '\u2014');
            cell(row, day(deletion.purgeAfter));

            const button = document.createElement('button');
            button.className = 'button button--compact';
            button.type = 'button';
            button.textContent = 'Restore';
            button.addEventListener('click', () => restore(deletion.slug, button));
            cell(row, '').appendChild(button);

            rows.appendChild(row);
        }

        state.hidden = true;
        $('deletions').hidden = false;
    }

    async function load() {
        let response;
        try {
            response = await fetch('/api/manage/deletions', { cache: 'no-store' });
        } catch {
            show('Could not load this page. Please try again.');
            return;
        }

        if (response.status === 401) {
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return;
        }
        if (!response.ok) {
            show('Nothing here.');
            return;
        }

        const body = await response.json();
        const deletions = Array.isArray(body.deletions) ? body.deletions : [];

        // The ordinary state, and worth saying plainly rather than showing an
        // empty table: the point of the visit is usually to confirm that
        // nothing is waiting.
        if (!deletions.length) {
            show('No archives are waiting to be erased.');
            return;
        }

        draw(deletions);
    }

    load();
})();
