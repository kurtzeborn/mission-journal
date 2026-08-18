// The book page: ask for one, watch it being made, look at what came out.
//
// The building itself happens on a queue and takes minutes, so nothing here
// is a request-and-response -- the button starts a job and everything after
// it is polling. That shape is why this is a page of its own rather than a
// control on the archive: a spinner that runs for four minutes needs somewhere
// to live that is not on top of the letters.

(() => {
    'use strict';

    // `/book/<slug>`, read from the path so this page has the same shape as
    // `/settings/<slug>` and `/people/<slug>` beside it.
    const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '');

    const $ = (id) => document.getElementById(id);
    const state = $('state');
    const said = $('said');

    // How often to ask, and for how long. Four seconds is slow enough to be
    // free and fast enough that a small book looks instant; twenty minutes is
    // longer than any build should ever take, and stopping there is how a
    // browser tab left open overnight stops being a request every four
    // seconds until the laptop is closed.
    const EVERY = 4000;
    const GIVE_UP_AFTER = 20 * 60 * 1000;

    let watchingSince = 0;
    let timer = null;

    const show = (message) => {
        state.textContent = message;
        state.hidden = false;
        $('everything').hidden = true;
    };

    const url = `/api/book/${encodeURIComponent(slug)}`;

    // Every refusal this page can meet, handled once, exactly as on the
    // settings page. Shared by the load, the request and the polling so they
    // cannot disagree about what a 403 means.
    function refused(response) {
        if (response.status === 401) {
            // Through the chooser, never straight at a provider: there are two
            // and guessing strands people on an account no archive has heard
            // of.
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return true;
        }
        if (response.status === 403) {
            show('Only owners can print an archive as a book.');
            return true;
        }
        return false;
    }

    /**
     * Draw whatever the server last said about the newest book.
     *
     * Every path through this page ends here, including the one that has just
     * pressed the button -- the request returns the same shape the polling
     * does, so there is one place that decides what the page looks like.
     */
    function draw(status) {
        const finished = $('finished');
        const make = $('make');

        if (status.state === 'building') {
            said.textContent = 'Making your book. This takes a few minutes, and you can close this page \u2014 it carries on without you.';
            make.disabled = true;
            finished.hidden = true;
            return;
        }

        make.disabled = false;

        if (status.state === 'failed') {
            // The server's own sentence. Its failures are written for the
            // person reading them and say things like "there are no letters
            // to print yet", which is fixable; "something went wrong" is not.
            said.textContent = status.error
                ? `That did not work: ${status.error}`
                : 'That did not work. Try again.';
            finished.hidden = true;
            return;
        }

        if (status.state !== 'ready') return;

        said.textContent = '';

        const when = new Date(status.builtAt);
        const made = Number.isNaN(when.getTime())
            ? ''
            : ` on ${when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;

        // Sheets rather than leaves, because that is what the printer counts
        // and what the book will physically be. Short archives are padded up
        // to two dozen, so this is often more than the letters account for.
        $('about').textContent =
            `${status.letters} letter${status.letters === 1 ? '' : 's'}, ` +
            `${status.pages} pages, made${made}.`;

        $('proof').href = `${url}/${encodeURIComponent(status.id)}/proof.pdf`;
        $('print').href = `${url}/${encodeURIComponent(status.id)}/letters.pdf`;
        finished.hidden = false;

        // The button stays live and still says "make the book", because a
        // book made before the last three letters arrived is exactly the
        // thing an owner comes back here to redo.
        $('make').textContent = 'Make it again';
    }

    function stopWatching() {
        if (timer) clearTimeout(timer);
        timer = null;
    }

    function watch() {
        stopWatching();
        timer = setTimeout(look, EVERY);
    }

    /**
     * Ask how the newest book is doing.
     *
     * @param {boolean} first Whether this is the load rather than a poll --
     *   the load is the only one allowed to decide the page is unusable.
     */
    async function look(first = false) {
        let response;
        try {
            response = await fetch(url, { cache: 'no-store' });
        } catch {
            if (first) show('Could not load this page. Please try again.');
            // A poll that fails is a laptop that went to sleep or a train
            // going into a tunnel, and neither is worth throwing the page
            // away over. Try again on the next tick.
            else watch();
            return;
        }

        if (refused(response)) return;

        if (response.status === 404) {
            // No book has ever been asked for. That is the ordinary state of
            // this page and not an error -- it is the page for making the
            // first one.
            if (first) ready(await wantedByTheCover());
            return;
        }

        if (!response.ok) {
            if (first) show('This archive is not available to you.');
            return;
        }

        const status = await response.json();
        if (first) ready(status.missing);

        draw(status);

        if (status.state !== 'building') return;
        if (Date.now() - watchingSince > GIVE_UP_AFTER) {
            said.textContent =
                'This is taking much longer than it should. Reload the page, and if it still says this, try again.';
            return;
        }

        watch();
    }

    function ready(missing = []) {
        state.hidden = true;
        $('everything').hidden = false;
        $('back').href = `/${encodeURIComponent(slug)}/`;

        if (missing.includes('mission')) {
            $('wanting-link').href = `/settings/${encodeURIComponent(slug)}`;
            $('wanting').hidden = false;
        }
    }

    /**
     * What the cover is missing, on a site that has never made a book.
     *
     * The status endpoint has nothing to say until one has been asked for,
     * and what goes on a cover is a fact about the archive rather than about
     * the book -- so on a first visit it comes from the profile instead. That
     * is one extra request on the one path where there is nothing else to
     * fetch, and it is the visit where the prompt is worth anything: after a
     * book exists, saying the mission is missing is a complaint about a book
     * that has already been made.
     */
    async function wantedByTheCover() {
        try {
            const response = await fetch(`/api/profile/${encodeURIComponent(slug)}`, {
                cache: 'no-store'
            });
            if (!response.ok) return [];

            const profile = await response.json();
            return profile.mission ? [] : ['mission'];
        } catch {
            return [];
        }
    }

    async function make() {
        const button = $('make');
        button.disabled = true;
        said.textContent = 'Asking\u2026';

        let response;
        try {
            response = await fetch(url, { method: 'POST' });
        } catch {
            button.disabled = false;
            said.textContent = 'Could not reach the server. Nothing has been started.';
            return;
        }

        if (refused(response)) return;

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
            button.disabled = false;
            said.textContent = body.error ?? 'That did not start.';
            // The one refusal with a way out of it: an archive with no name
            // cannot be a book, because the name is the title.
            if ((body.missing ?? []).includes('displayName')) {
                $('wanting-link').href = `/settings/${encodeURIComponent(slug)}`;
                $('wanting').hidden = false;
            }
            return;
        }

        watchingSince = Date.now();
        draw(body);
        watch();
    }

    // Polling stops while the tab is in the background and picks up again
    // when it comes forward, which is where most of these builds are watched
    // from -- somebody presses the button and goes to do something else.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopWatching();
        else if (watchingSince) look();
    });

    $('make').addEventListener('click', make);
    watchingSince = Date.now();
    look(true);
})();
