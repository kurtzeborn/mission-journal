// The operator's page: what is arriving, what was turned away, what has been
// deleted, and the doors back from the last two.
//
// Arrivals always has every archive in it and the common case is confirming
// the top row is recent -- it is the only view in the service that spans
// archives, so it is the only place ingest having stopped can be noticed.
// Refusals should be empty and every row in it is a family who tried to start
// an archive and could not; it is the only place a rejection is visible at
// all, since one writes nothing and tells only the person it happened to.
// Deletions is ordinarily empty and is the entire recovery path for a deletion
// somebody regrets, since there is no owner-facing undo: the confirmation on
// the settings page says the archive is gone and nothing here contradicts it.
//
// The page is not linked from anywhere, and every API behind it refuses
// everyone not on OPERATOR_EMAILS with a 404, so a stranger who finds the URL
// sees the same "nothing here" as a stranger who mistypes one.

(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const state = $('state');
    const said = $('said');

    // Nothing about this page is shown until the API has said the visitor is
    // an operator -- not the heading, not the explanation, not the title. The
    // markup is served to anyone signed in, because Static Web Apps roles
    // cannot express OPERATOR_EMAILS and the route can only ask for
    // `authenticated`, so this is the only place the distinction can be drawn
    // in the browser.
    const reveal = () => {
        $('loading').hidden = true;
        $('tooling').hidden = false;
        document.title = 'Service tooling \u2014 Pday Letters';
    };

    // What a stranger sees, and what an operator sees if they mistype: the
    // same nothing. The API answers 404 rather than 403 so the route is never
    // confirmed, and it would be pointless for the page to confirm it instead.
    const refuse = () => {
        $('loading').hidden = true;
        $('missing').hidden = false;
    };

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

    // Whole days, rounded down, from a timestamp to now. Only the headline
    // uses it: putting it on every row would be a column of arithmetic nobody
    // asked for, and the sort order already says which archives are quiet.
    const ago = (value) => {
        const when = new Date(value);
        if (Number.isNaN(when.getTime())) return '';
        const days = Math.floor((Date.now() - when.getTime()) / 86400000);
        if (days < 0) return '';
        if (days === 0) return 'today';
        return days === 1 ? 'yesterday' : `${days} days ago`;
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

    // The arrivals half. Drawn only after the deletions call has confirmed the
    // visitor, so a refused stranger never sees a table flash up behind the
    // "nothing here" panel.
    function drawFlow(archives) {
        const rows = $('flow-rows');
        rows.replaceChildren();

        for (const archive of archives) {
            const row = document.createElement('tr');
            cell(row, archive.slug);
            cell(row, archive.name || '\u2014');
            cell(row, archive.state);
            cell(row, archive.lastReceivedAt ? day(archive.lastReceivedAt) : '\u2014');
            cell(row, archive.lastPostAt ? day(archive.lastPostAt) : '\u2014');
            cell(row, waiting(archive));
            rows.appendChild(row);
        }

        $('flow').hidden = false;
    }

    // Letters held and not published. Ordinarily nothing, which is why it is
    // one cell rather than two columns of blanks: on a pending archive it is
    // the whole story and carries the date the letters are destroyed, and on a
    // live one it means promotion failed partway and left the only copy of
    // somebody's mail in a container nothing reads.
    const waiting = (archive) => {
        if (!archive.held) return '\u2014';
        const letters = `${archive.held} letter${archive.held === 1 ? '' : 's'}`;
        return archive.expiresAt ? `${letters}, until ${day(archive.expiresAt)}` : letters;
    };

    async function loadFlow() {
        const where = $('flow-state');

        let response;
        try {
            response = await fetch('/api/manage/last-received', { cache: 'no-store' });
        } catch {
            where.textContent = 'Could not load the arrivals. Please try again.';
            return;
        }

        if (!response.ok) {
            where.textContent = 'Could not load the arrivals.';
            return;
        }

        const body = await response.json();
        const archives = Array.isArray(body.archives) ? body.archives : [];

        if (!archives.length) {
            where.textContent = 'There are no archives yet.';
            return;
        }

        // Said above the table as well as being derivable from the top row,
        // because it is the one fact somebody comes here for and reading it
        // out of a sorted table means trusting the sort. The same slot carries
        // the failures above, which is why the class moves: centred in a box
        // is right for "nothing loaded" and wrong for a sentence with a table
        // under it.
        const since = ago(body.lastReceivedAt);
        where.className = 'note';
        where.textContent = body.lastReceivedAt
            ? `The service last received a letter ${since}, on ${day(body.lastReceivedAt)}.`
            : 'No letters have arrived yet.';

        drawFlow(archives);
    }

    // The refusals half. Every row is somebody who tried to start an archive
    // and was told no, so the buttons are ordered the way they should be
    // tried: the harmless one first, the forcing one last.
    const REFUSALS = {
        'bootstrap-not-attached': {
            why: 'Pasted in, not attached',
            kind: 'attach'
        },
        'bootstrap-unverified': {
            why: 'The signature did not survive the forward',
            kind: 'rebuilt'
        }
    };

    const refusedSaid = () => $('refused-said');

    async function act(rejection, what, button, buttons) {
        const where = refusedSaid();
        for (const other of buttons) other.disabled = true;
        where.textContent = `Working on ${rejection.slug}\u2026`;

        const at = `/api/manage/rejections/${encodeURIComponent(rejection.slug)}/${encodeURIComponent(rejection.ulid)}`;
        const url =
            what === 'advise'
                ? `${at}/advise?to=${encodeURIComponent(rejection.sender)}` +
                  `&author=${encodeURIComponent(rejection.author)}` +
                  `&kind=${encodeURIComponent(REFUSALS[rejection.reason]?.kind ?? 'attach')}`
                : `${at}/${what}`;

        let response;
        try {
            response = await fetch(url, { method: 'POST', cache: 'no-store' });
        } catch {
            where.textContent = 'Could not reach the server. Nothing was changed.';
            for (const other of buttons) other.disabled = false;
            return;
        }

        if (!response.ok) {
            where.textContent =
                response.status === 404
                    ? 'That letter is no longer here. It may have aged out of the inbox.'
                    : 'Something went wrong. Nothing was changed.';
            for (const other of buttons) other.disabled = false;
            return;
        }

        const body = await response.json();

        if (what === 'advise') {
            where.textContent = `Advice sent again to ${rejection.sender}.`;
            for (const other of buttons) other.disabled = false;
            return;
        }

        // `rejected` is the ordinary outcome of a retry that did not help, and
        // it is worth saying which refusal it hit: the same letter can fail a
        // second way once the first is out of the road.
        if (body.status === 'rejected') {
            where.textContent = `Still refused: ${body.reason ?? 'no reason given'}.`;
            for (const other of buttons) other.disabled = false;
            return;
        }

        where.textContent = `${rejection.slug} is started. It is waiting to be claimed.`;
        loadRefused();
    }

    function action(rejection, label, what, buttons, ask) {
        const button = document.createElement('button');
        button.className = 'button button--compact';
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', async () => {
            if (ask && !(await ask())) return;
            act(rejection, what, button, buttons);
        });
        buttons.push(button);
        return button;
    }

    function drawRefused(rejections) {
        const rows = $('refused-rows');
        rows.replaceChildren();

        for (const rejection of rejections) {
            const row = document.createElement('tr');
            cell(row, rejection.slug);
            cell(row, rejection.sender || '\u2014');
            cell(row, rejection.subject || '\u2014');
            cell(row, day(rejection.at));
            cell(row, REFUSALS[rejection.reason]?.why ?? rejection.reason);

            const buttons = [];
            const actions = cell(row, '');
            actions.className = 'actions';
            actions.appendChild(action(rejection, 'Retry', 'retry', buttons));
            actions.appendChild(action(rejection, 'Advise again', 'advise', buttons));

            // The only irreversible one on this page, and the only one that
            // creates something out of evidence we do not have. Asked plainly,
            // by name, because an operator working down a list of rows should
            // have to read the slug they are about to conjure a site for.
            actions.appendChild(
                action(rejection, 'Start it anyway', 'bypass', buttons, () =>
                    window.Confirm.ask({
                        question: `Start ${rejection.slug} without verifying the letter?`,
                        detail:
                            `Nothing proves this letter came from ${rejection.author || 'the missionary'} ` +
                            'except your own reading of it. The archive will be held until somebody claims it.',
                        action: 'Start it anyway'
                    })
                )
            );

            rows.appendChild(row);
        }

        $('refused-state').hidden = true;
        $('refused').hidden = false;
    }

    async function loadRefused() {
        const where = $('refused-state');
        where.hidden = false;
        $('refused').hidden = true;

        let response;
        try {
            response = await fetch('/api/manage/rejections', { cache: 'no-store' });
        } catch {
            where.textContent = 'Could not load the refusals. Please try again.';
            return;
        }

        if (!response.ok) {
            where.textContent = 'Could not load the refusals.';
            return;
        }

        const body = await response.json();
        const rejections = Array.isArray(body.rejections) ? body.rejections : [];

        // Worth saying rather than showing an empty table, and worth saying
        // this way round: nothing here is the good outcome.
        if (!rejections.length) {
            where.textContent = 'No first letters have been turned away.';
            return;
        }

        drawRefused(rejections);
    }

    async function load() {
        let response;
        try {
            response = await fetch('/api/manage/deletions', { cache: 'no-store' });
        } catch {
            // Deliberately not `refuse()`. A dropped connection is not an
            // answer about who the visitor is, and telling an operator the
            // page does not exist because their train went into a tunnel
            // would send them looking for the wrong problem.
            $('loading').textContent = 'Could not load this page. Please try again.';
            return;
        }

        if (response.status === 401) {
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return;
        }
        if (!response.ok) {
            refuse();
            return;
        }

        const body = await response.json();
        const deletions = Array.isArray(body.deletions) ? body.deletions : [];

        reveal();

        // Not awaited. The two halves answer different questions and neither
        // is worth making the other wait for -- and the deletions call has
        // already settled the only question they share, which is whether the
        // page should be on screen at all.
        loadFlow();
        loadRefused();

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
