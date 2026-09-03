// The operator's page: what is arriving, what was turned away, what is
// waiting to be claimed, and the doors back from the last two.
//
// Arrivals always has every archive in it and the common case is confirming
// the top row is recent -- it is the only view in the service that spans
// archives, so it is the only place ingest having stopped can be noticed.
// Refusals should be empty and every row in it is a family who tried to start
// an archive and could not; it is the only place a rejection is visible at
// all, since one writes nothing and tells only the person it happened to.
// Waiting is the same silence one step later: the letters were kept, and the
// email that would have told somebody so is the part that went missing.
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

    // Slug -> the three count cells in its arrivals row, so the stats call can
    // fill them whenever it lands.
    const countCells = new Map();

    // The arrivals half. Drawn only after the deletions call has confirmed the
    // visitor, so a refused stranger never sees a table flash up behind the
    // "nothing here" panel.
    function drawFlow(archives) {
        const rows = $('flow-rows');
        rows.replaceChildren();
        countCells.clear();

        for (const archive of archives) {
            const row = document.createElement('tr');
            cell(row, archive.slug);
            cell(row, archive.state);
            cell(row, archive.lastReceivedAt ? day(archive.lastReceivedAt) : '\u2014');
            cell(row, archive.lastPostAt ? day(archive.lastPostAt) : '\u2014');
            cell(row, waiting(archive));

            // Filled by the stats route, which is still in flight. Held by
            // reference rather than found again later: the two calls sort
            // independently, so position is not a key and a selector would be
            // one more thing to keep in step with the markup.
            const boxes = {};
            for (const field of ['letters', 'photos', 'people']) {
                const box = cell(row, '\u2014');
                box.className = 'count';
                boxes[field] = box;
            }
            countCells.set(archive.slug, boxes);

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
        // the failures above, which is why the class moves: centered in a box
        // is right for "nothing loaded" and wrong for a sentence with a table
        // under it.
        const since = ago(body.lastReceivedAt);
        where.className = 'note';
        where.textContent = body.lastReceivedAt
            ? `The service last received a letter ${since}, on ${day(body.lastReceivedAt)}.`
            : 'No letters have arrived yet.';

        drawFlow(archives);
        if (counted) fillCounts(counted);
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

    // The waiting half. Every row is an archive holding letters that nobody
    // has been able to open, and the column that matters is "Offered": blank
    // means the one email that would have told anybody was never delivered.
    async function offerAgain(site, button) {
        const where = $('waiting-said');
        button.disabled = true;
        where.textContent = `Writing to ${site.recipient}\u2026`;

        let response;
        try {
            response = await fetch(`/api/manage/pending/${encodeURIComponent(site.slug)}/offer`, {
                method: 'POST',
                cache: 'no-store'
            });
        } catch {
            where.textContent = 'Could not reach the server. Nothing was sent.';
            button.disabled = false;
            return;
        }

        if (!response.ok) {
            where.textContent = 'Something went wrong. Nothing was sent.';
            button.disabled = false;
            return;
        }

        const body = await response.json();

        if (body.status !== 'sent') {
            // `blocked` is the allowlist, and while it is narrow it is the
            // likeliest answer here -- worth naming rather than reporting as
            // a failure the operator might go looking for in the logs.
            where.textContent =
                body.status === 'blocked'
                    ? `${site.recipient} is not on the mail allowlist, so nothing was sent.`
                    : `Could not send it: ${body.status}.`;
            button.disabled = false;
            return;
        }

        where.textContent = `The claim link for ${site.slug} is on its way to ${site.recipient}.`;
        loadWaiting();
    }

    function drawWaiting(sites) {
        const rows = $('waiting-rows');
        rows.replaceChildren();

        for (const site of sites) {
            const row = document.createElement('tr');
            cell(row, site.slug);
            cell(row, site.recipient || '\u2014');
            cell(row, String(site.messageCount));
            cell(row, site.offeredAt ? day(site.offeredAt) : 'never');
            cell(row, day(site.expiresAt));

            const actions = cell(row, '');
            actions.className = 'actions';

            // Nothing to press when there is no address. The manifest records
            // the missionary, not whoever forwarded the letters, and on the
            // oldest held sites that is all there is -- writing to them would
            // hand a stranger's archive to the person it is about.
            if (!site.recipient) {
                actions.textContent = 'No return address';
                rows.appendChild(row);
                continue;
            }

            const button = document.createElement('button');
            button.className = 'button button--compact';
            button.type = 'button';
            button.textContent = site.offerCount ? 'Send it again' : 'Send the claim link';
            button.addEventListener('click', async () => {
                // Only when one has already gone out. Re-minting invalidates
                // whatever link is in somebody's inbox, and the first press
                // on a site nobody has ever been told about cannot break
                // anything, so asking then would be ceremony.
                if (site.offerCount) {
                    const ok = await window.Confirm.ask({
                        question: `Send ${site.slug} a new claim link?`,
                        detail: `Any link already sent to ${site.recipient} will stop working.`,
                        action: 'Send it again'
                    });
                    if (!ok) return;
                }
                offerAgain(site, button);
            });
            actions.appendChild(button);

            rows.appendChild(row);
        }

        $('waiting-state').hidden = true;
        $('waiting').hidden = false;
    }

    async function loadWaiting() {
        const where = $('waiting-state');
        where.hidden = false;
        $('waiting').hidden = true;

        let response;
        try {
            response = await fetch('/api/manage/pending', { cache: 'no-store' });
        } catch {
            where.textContent = 'Could not load the waiting archives. Please try again.';
            return;
        }

        if (!response.ok) {
            where.textContent = 'Could not load the waiting archives.';
            return;
        }

        const body = await response.json();
        const sites = Array.isArray(body.pending) ? body.pending : [];

        if (!sites.length) {
            where.textContent = 'No archives are waiting to be claimed.';
            return;
        }

        drawWaiting(sites);
    }

    // How big the service is. Four numbers, no controls, and the only part of
    // this page that is only ever read.
    function drawTally(totals) {
        const tally = $('tally');
        tally.replaceChildren();

        // Hidden letters are said as an aside on the letters figure rather
        // than as a box of their own: it is a fact about that total, and a
        // fifth box would give it equal weight with the size of the service.
        const boxes = [
            ['Archives', totals.archives, ''],
            ['Letters', totals.letters, totals.hidden ? `${totals.hidden} hidden` : ''],
            ['Photographs', totals.photos, ''],
            ['People', totals.people, 'counted once each']
        ];

        for (const [label, value, aside] of boxes) {
            const box = document.createElement('div');
            box.className = 'tally__box';

            const name = document.createElement('dt');
            name.textContent = label;

            const number = document.createElement('dd');
            number.className = 'tally__number';
            number.textContent = Number(value ?? 0).toLocaleString();

            box.appendChild(name);
            box.appendChild(number);

            if (aside) {
                const under = document.createElement('dd');
                under.className = 'tally__aside';
                under.textContent = aside;
                box.appendChild(under);
            }

            tally.appendChild(box);
        }

        $('tally-state').hidden = true;
        tally.hidden = false;
    }

    // What the stats call returned. Kept because the two calls race, and
    // whichever finishes second is the one that puts the numbers in the table.
    let counted = null;

    // The per-archive numbers, dropped into whichever arrivals rows exist. A
    // slug with no row is an archive the arrivals call did not return, which
    // is not this function's problem to report.
    function fillCounts(archives) {
        for (const archive of archives) {
            const boxes = countCells.get(archive.slug);
            if (!boxes) continue;
            for (const field of ['letters', 'photos', 'people']) {
                boxes[field].textContent = Number(archive[field] ?? 0).toLocaleString();
            }
        }
    }

    async function loadStats() {
        const where = $('tally-state');

        let response;
        try {
            response = await fetch('/api/manage/stats', { cache: 'no-store' });
        } catch {
            where.textContent = 'Could not count the archives. Please try again.';
            return;
        }

        if (!response.ok) {
            where.textContent = 'Could not count the archives.';
            return;
        }

        const body = await response.json();
        drawTally(body.totals ?? {});

        counted = Array.isArray(body.archives) ? body.archives : [];
        fillCounts(counted);
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
        loadStats();
        loadFlow();
        loadRefused();
        loadWaiting();

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
