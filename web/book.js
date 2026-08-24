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

    // Which book the finished panel is currently describing, so a checkout
    // page made for one build is not left on screen beside another.
    let newest = '';

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

        // A checkout belongs to one book. Rebuilding replaces the book, so
        // the link from the last one is put away rather than left sitting
        // under a different set of letters.
        if (status.id !== newest) {
            newest = status.id;
            $('checkout').hidden = true;
            $('order-said').textContent = '';
        }

        // Hidden entirely where the printer is not configured, rather than
        // shown and then apologetic. An environment without the keys has no
        // way to sell a book and should not offer to.
        $('printing').hidden = !status.printing;

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
            if (first) ready();
            return;
        }

        if (!response.ok) {
            if (first) show('This archive is not available to you.');
            return;
        }

        const status = await response.json();
        if (first) ready();

        draw(status);

        if (status.state !== 'building') return;
        if (Date.now() - watchingSince > GIVE_UP_AFTER) {
            said.textContent =
                'This is taking much longer than it should. Reload the page, and if it still says this, try again.';
            return;
        }

        watch();
    }

    function ready() {
        state.hidden = true;
        $('everything').hidden = false;
        $('back').href = `/${encodeURIComponent(slug)}/`;

        dressTheCover();
    }

    // --- the cover ---------------------------------------------------------
    //
    // Saved on its own as soon as it is chosen rather than sent along with the
    // request to print. Two reasons: an owner who picks a color and then
    // wanders off has still chosen a color, and the next book -- a year
    // later, from a different device -- is bound like the first without
    // anybody having to remember what they did.

    // Filled from the server, because the hexes are also what gets drawn into
    // the PDF and one copy of a color is the most any color should have.
    let cloths = [];
    let chosen = { cloth: '', picture: '' };
    let archive = null;

    const coverUrl = `${url}/cover`;
    const coverSaid = () => $('cover-said');

    /**
     * Redraw the little board on the left.
     *
     * Not a rendering of the PDF and not trying to be. The proportions, the
     * colors and where the picture sits are right; the type is the browser's.
     */
    function paint() {
        const cloth = cloths.find((entry) => entry.name === chosen.cloth) ?? cloths[0];
        if (!cloth) return;

        const board = $('board');
        board.style.background = cloth.paper;
        $('board-name').style.color = cloth.ink;
        $('board-mission').style.color = cloth.quiet;

        const plate = $('plate');
        if (chosen.picture) {
            plate.src = chosen.picture === 'own'
                ? `${url}/cover.webp?v=${Date.now()}`
                : `/api/photo/${encodeURIComponent(slug)}/${encodeURIComponent(chosen.picture)}/large.webp`;
            plate.hidden = false;
        } else {
            plate.removeAttribute('src');
            plate.hidden = true;
        }

        // The name sits under the picture when there is one and a fifth of
        // the way down when there is not, which is what the book does.
        $('board-name').style.top = chosen.picture ? '58%' : '26%';
        $('board-mission').style.top = chosen.picture ? '74%' : '40%';

        for (const button of $('cloths').children) {
            button.setAttribute('aria-pressed', String(button.dataset.cloth === chosen.cloth));
        }

        for (const button of $('grid').children) {
            button.setAttribute('aria-pressed', String(button.dataset.photo === chosen.picture));
        }
    }

    async function keep(next) {
        const before = chosen;
        chosen = next;
        paint();

        let response;
        try {
            response = await fetch(coverUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chosen)
            });
        } catch {
            chosen = before;
            paint();
            coverSaid().textContent = 'Could not save that. Nothing has changed.';
            return;
        }

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            chosen = before;
            paint();
            coverSaid().textContent = body.error ?? 'Could not save that.';
            return;
        }

        coverSaid().textContent = 'Saved.';
    }

    /**
     * The archive's photographs, to choose one from.
     *
     * Fetched from the same file the reader is built out of, so a picture that
     * belongs to a letter the owner has hidden is not offered -- a cover is
     * the most public page of a book, and it would be a strange place for the
     * one letter they decided not to publish to reappear.
     */
    async function photographs() {
        if (archive) return archive;

        const response = await fetch(`/api/content/${encodeURIComponent(slug)}/posts.json`, {
            cache: 'no-store'
        });
        if (!response.ok) return (archive = []);

        const body = await response.json();
        archive = (body.posts ?? []).flatMap((post) => post.photos ?? []).map((photo) => photo.id);
        return archive;
    }

    async function offerPictures() {
        const grid = $('grid');
        if (!grid.hidden) {
            grid.hidden = true;
            return;
        }

        coverSaid().textContent = 'Looking\u2026';
        const ids = await photographs();
        coverSaid().textContent = ids.length ? '' : 'There are no photographs in this archive yet.';

        grid.textContent = '';
        for (const id of ids) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'cover__thumb';
            button.dataset.photo = id;
            button.setAttribute('aria-pressed', String(id === chosen.picture));

            const img = document.createElement('img');
            img.src = `/api/photo/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/thumb.webp`;
            img.alt = 'A photograph from the archive';
            img.loading = 'lazy';

            button.appendChild(img);
            button.addEventListener('click', () => keep({ ...chosen, picture: id }));
            grid.appendChild(button);
        }

        grid.hidden = !ids.length;
    }

    async function uploadPicture(file) {
        coverSaid().textContent = 'Uploading\u2026';

        let response;
        try {
            response = await fetch(`${url}/cover.webp`, {
                method: 'POST',
                headers: { 'Content-Type': file.type },
                body: file
            });
        } catch {
            coverSaid().textContent = 'That did not upload. Try again.';
            return;
        }

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            coverSaid().textContent = body.error ?? 'That picture could not be used.';
            return;
        }

        $('grid').hidden = true;
        await keep({ ...chosen, picture: 'own' });
    }

    /**
     * Set the cover panel up, once, after the page is known to be usable.
     *
     * Its own request rather than something folded into the status, because
     * the cover is a fact about the archive and the status is a fact about one
     * build -- and this page is opened on plenty of archives that have never
     * had a book.
     */
    async function dressTheCover() {
        let response;
        try {
            response = await fetch(coverUrl, { cache: 'no-store' });
        } catch {
            return;
        }
        if (!response.ok) return;

        const body = await response.json();
        cloths = body.cloths ?? [];
        chosen = { cloth: body.cloth, picture: body.picture };

        // What the cover will actually say, so the preview is of this book
        // rather than of a book. The mission doubles as the prompt below: it
        // is the one thing a cover can be short of and still be printed.
        $('board-name').textContent = body.title;
        $('board-mission').textContent = body.mission || 'Letters from the mission';

        if (!body.mission) {
            $('wanting-link').href = `/settings/${encodeURIComponent(slug)}`;
            $('wanting').hidden = false;
        }

        const row = $('cloths');
        row.textContent = '';
        for (const cloth of cloths) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'cover__cloth';
            button.dataset.cloth = cloth.name;
            button.style.background = cloth.paper;
            // The only name any of these has. A swatch with no label is a
            // color a screen reader cannot describe.
            button.setAttribute('aria-label', cloth.name);
            button.addEventListener('click', () => keep({ ...chosen, cloth: cloth.name }));
            row.appendChild(button);
        }

        $('pick').addEventListener('click', offerPictures);
        $('bare').addEventListener('click', () => keep({ ...chosen, picture: '' }));
        $('own').addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the same file twice still fires a change,
            // which is what happens when the first attempt was refused.
            event.target.value = '';
            if (file) uploadPicture(file);
        });

        paint();
        $('cover').hidden = false;
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

    /**
     * Ask the printer for a checkout page for the book on screen.
     *
     * Nothing is bought here and nothing can be: what comes back is a URL at
     * the printer's own shop, where the buyer pays them, they print and they
     * post. No card, no address and no name reaches this service, which is
     * the whole reason this is a link rather than a form.
     */
    async function orderOne() {
        const button = $('order');
        const orderSaid = $('order-said');

        if (!newest) return;

        button.disabled = true;
        orderSaid.textContent = 'Asking the printer\u2026';

        let response;
        try {
            response = await fetch(`/api/print/${encodeURIComponent(slug)}/${encodeURIComponent(newest)}`, {
                method: 'POST'
            });
        } catch {
            button.disabled = false;
            orderSaid.textContent = 'Could not reach the server. Nothing has been ordered.';
            return;
        }

        if (refused(response)) return;

        button.disabled = false;

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
            // Their sentence again where there is one. `503 printing is not
            // switched on yet` is a true and useful thing to read, and much
            // better than a page pretending the button did something.
            orderSaid.textContent = body.error ?? 'That did not work. Try again.';
            return;
        }

        $('buy').href = body.checkoutUrl;
        $('checkout').hidden = false;
        // Said out loud rather than only shown, because pressing the button a
        // second time when a checkout already exists gives back the same link
        // and would otherwise look like nothing happened.
        orderSaid.textContent = body.reused
            ? 'This book already had a checkout page, so here it is again.'
            : '';
    }

    // Polling stops while the tab is in the background and picks up again
    // when it comes forward, which is where most of these builds are watched
    // from -- somebody presses the button and goes to do something else.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopWatching();
        else if (watchingSince) look();
    });

    $('make').addEventListener('click', make);
    $('order').addEventListener('click', orderOne);
    watchingSince = Date.now();
    look(true);
})();
