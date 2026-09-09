// Every photograph in the archive, as one page.
//
// The website only, and only from the Photo Album button. Clicking a picture
// in a letter opens the reader's own lightbox instead, here as well as in the
// zip: enlarging the photograph in front of you is a different request from
// asking to see all of them, and answering the first with the second sweeps
// the letter out from under the reader.
//
// The downloaded zip is not given this file at all. That is a decision rather
// than an oversight -- the album is where video will live, and video is not
// going in the download.
//
// The archive is a list of dates. The word cloud is a view of the same letters
// by what is in them; this is a view of them by what was photographed. Both
// open over the top rather than replacing anything, and both hand the reader
// back to a single letter when they find the one they were looking for -- that
// is the whole reason a picture is worth clicking here rather than in a folder
// of images.
//
// A grid of thumbnails and nothing else. What stood here before was a deck of
// cards driven by a slider library, and it failed the way that design has to
// fail: it built a slide for every photograph up front, it held the full-size
// image of every one it had passed, and it started a timer the moment it
// opened -- so on a slow first request it spent that timer moving past
// photographs that had not arrived. A grid asks the browser for the two dozen
// thumbnails on screen and nothing else, and a slow connection shows up as
// pictures filling in rather than as a slideshow running on empty.
//
// Two dialogs, one on top of the other. `.gallery` is where you look for a
// photograph; `.viewer` is where you look at one. Stacking them rather than
// swapping the contents of one is what makes closing the viewer put you back
// on the thumbnail you clicked, with the grid scrolled where you left it.
//
// Not `.album`, which is taken: reader.js already gives that class to the row
// of thumbnails under a single letter, and styles.css sets a `display` on it.
// An author `display` beats the browser's `dialog:not([open])` rule, so a
// dialog wearing that class stays on screen after it is closed.

/* global Reader */

window.Album = (function () {
    'use strict';

    const ORDERS = [
        ['oldest', 'Oldest first'],
        ['newest', 'Newest first'],
        ['random', 'Random order']
    ];

    // Oldest first, unlike the list behind it, which runs newest first because
    // a reader checking for a new letter wants the top of the page. Nobody
    // opens an album to see whether anything arrived; they open it to look
    // through, and looking through goes forwards.
    //
    // Kept between openings so the choice sticks for the visit, and not
    // remembered any longer than that.
    let order = 'oldest';

    // How long a photograph stays on screen once it has arrived.
    //
    // Once it has arrived is the whole of it. The clock does not start until
    // the picture is decoded, so on a cold connection the slideshow waits
    // instead of running ahead of the network -- which is what the thing this
    // replaces did, and why it looked broken rather than merely slow.
    const DWELL = 4000;

    /**
     * The photographs, in the order asked for, grouped by the letter they came
     * with.
     *
     * Grouping only survives a date order. Under "Random" the headings would
     * be one letter per picture, which is not a grouping, so the whole album
     * becomes a single block.
     */
    function planOf(posts, photoSrc, how) {
        // Posts arrive newest first. Reversing whole letters rather than the
        // finished list keeps the pictures inside one letter in the order they
        // were written around.
        const ordered = how === 'newest' ? posts : [...posts].reverse();

        const blocks = [];
        for (const post of ordered) {
            const photos = post.photos ?? [];
            if (!photos.length) continue;
            blocks.push({
                post,
                frames: photos.map((photo) => ({
                    post,
                    src: photoSrc(photo.id, 'large'),
                    thumb: photoSrc(photo.id, 'thumb')
                }))
            });
        }

        const frames = blocks.flatMap((block) => block.frames);

        if (how === 'random') {
            for (let i = frames.length - 1; i > 0; i -= 1) {
                const j = Math.floor(Math.random() * (i + 1));
                [frames[i], frames[j]] = [frames[j], frames[i]];
            }
        }

        // Its own position, so a thumbnail can name the picture it opens
        // without a click handler having to work out where it sits.
        frames.forEach((frame, at) => { frame.at = at; });

        return { blocks: how === 'random' ? [{ post: null, frames }] : blocks, frames };
    }

    const titleOf = (post) => {
        const date = Reader.formatDate(post.originalDate);
        const subject = post.subject || 'Untitled';
        return date ? `${date} \u2014 ${subject}` : subject;
    };

    // --- the viewer -------------------------------------------------------

    let viewer = null;

    function ensureViewer() {
        if (viewer) return viewer;

        const dialog = document.createElement('dialog');
        dialog.className = 'viewer';

        // Behind the photograph and blurred, so a slow fetch shows the picture
        // softly rather than showing nothing. It costs no request: the grid
        // has already put every thumbnail it painted into the browser's cache,
        // so this is on screen in the same frame as the click.
        const standin = document.createElement('img');
        standin.className = 'viewer__standin';
        standin.alt = '';
        standin.decoding = 'async';

        // Contained rather than cropped, unlike the grid. A photograph being
        // looked at wants its whole frame, and the parts a crop takes are
        // where a phone camera puts the people.
        const image = document.createElement('img');
        image.className = 'viewer__image';
        image.alt = '';
        image.decoding = 'async';

        const stage = document.createElement('div');
        stage.className = 'viewer__stage';
        stage.append(standin, image);

        const arrow = (label, glyph, delta) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `viewer__step viewer__step--${delta < 0 ? 'back' : 'on'}`;
            el.setAttribute('aria-label', label);
            el.textContent = glyph;
            el.addEventListener('click', () => step(delta));
            return el;
        };

        const previous = arrow('Previous photograph', '\u2039', -1);
        const next = arrow('Next photograph', '\u203a', 1);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'viewer__close';
        close.setAttribute('aria-label', 'Close this photograph');
        close.textContent = '\u00d7';
        close.addEventListener('click', () => dialog.close());

        const caption = document.createElement('p');
        caption.className = 'viewer__caption';

        const where = document.createElement('p');
        where.className = 'viewer__where';

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'button button--quiet button--compact viewer__play';
        play.textContent = 'Play';
        play.addEventListener('click', () => setPlaying(!viewer.playing));

        const goTo = document.createElement('button');
        goTo.type = 'button';
        goTo.className = 'button button--quiet button--compact viewer__goto';
        goTo.textContent = 'Go to this letter';
        goTo.addEventListener('click', () => {
            const post = viewer.frames[viewer.at]?.post;
            if (!post) return;
            dialog.close();
            gallery.dialog.close();
            gallery.reveal?.(post.id);
        });

        const foot = document.createElement('div');
        foot.className = 'viewer__foot';
        foot.append(caption, where, play, goTo);

        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowRight') step(1);
            else if (event.key === 'ArrowLeft') step(-1);
            else return;
            event.preventDefault();
        });

        // A click on the dark around the picture leaves, which is what every
        // other image viewer does. The stage fills the dialog and the
        // photograph is contained inside it, so the letterboxing either side
        // belongs to the stage rather than to the dialog box -- both have to
        // count as "not the picture".
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog || event.target === stage) dialog.close();
        });

        // Everything the viewer was doing stops when it goes away: the timer,
        // because it would otherwise advance a closed dialog, and the src,
        // because a 2400px photograph is a lot of memory to leave held for a
        // window nobody is looking at.
        //
        // The grid is scrolled to the picture that was up, which matters after
        // a slideshow has run: it may be a hundred thumbnails from the one
        // that was clicked, and landing back at the old scroll position would
        // lose the reader.
        dialog.addEventListener('close', () => {
            setPlaying(false);
            image.removeAttribute('src');
            standin.removeAttribute('src');
            gallery?.cells[viewer.at]?.scrollIntoView({ block: 'nearest' });
        });

        dialog.append(stage, previous, next, close, foot);
        document.body.append(dialog);

        viewer = {
            dialog, stage, image, standin, caption, where, play, goTo,
            frames: [], at: 0, playing: false, timer: 0, pass: 0
        };

        return viewer;
    }

    function describe() {
        const frame = viewer.frames[viewer.at];
        if (!frame) return;
        viewer.caption.textContent = titleOf(frame.post);
        viewer.where.textContent = `${viewer.at + 1} / ${viewer.frames.length}`;
    }

    /**
     * Start the clock on the picture that is up, once it is up.
     *
     * `pass` is the showing it was armed for. Every move increments it, so a
     * reader who presses the arrow while a slow photograph is still coming
     * down does not get that photograph's timer firing underneath the one they
     * asked for.
     */
    function arm(pass) {
        if (!viewer.playing) return;

        const start = () => {
            if (pass !== viewer.pass || !viewer.playing) return;
            viewer.timer = setTimeout(() => step(1), DWELL);
        };

        // A picture that never arrives must not park the slideshow for good,
        // so a failed load starts the clock the same as a good one.
        if (viewer.image.complete) start();
        else {
            viewer.image.addEventListener('load', start, { once: true });
            viewer.image.addEventListener('error', start, { once: true });
        }
    }

    function show(index) {
        const total = viewer.frames.length;
        if (!total) return;

        const at = ((index % total) + total) % total;
        const frame = viewer.frames[at];

        clearTimeout(viewer.timer);
        viewer.at = at;
        viewer.pass += 1;
        const pass = viewer.pass;

        viewer.standin.src = frame.thumb;
        viewer.standin.hidden = false;
        viewer.image.src = frame.src;

        const settle = () => { if (pass === viewer.pass) viewer.standin.hidden = true; };
        viewer.image.addEventListener('load', settle, { once: true });
        if (viewer.image.complete) settle();

        // One ahead, and only one. It is the picture most likely to be asked
        // for next whether the reader is pressing the arrow or watching the
        // slideshow, and each of these is most of a megabyte.
        const after = viewer.frames[(at + 1) % total];
        if (after !== frame) new Image().src = after.src;

        describe();
        arm(pass);
    }

    // Round rather than stopping at the end, so a slideshow left running does
    // not stop of its own accord in the middle of somebody's evening.
    const step = (delta) => show(viewer.at + delta);

    function setPlaying(on) {
        clearTimeout(viewer.timer);
        viewer.playing = on;
        viewer.play.textContent = on ? 'Pause' : 'Play';
        if (on) arm(viewer.pass);
    }

    // --- the grid ---------------------------------------------------------

    let gallery = null;

    function ensureGallery() {
        if (gallery) return gallery;

        const dialog = document.createElement('dialog');
        dialog.className = 'gallery';

        const title = document.createElement('h2');
        title.className = 'gallery__title';
        title.id = 'gallery-title';
        title.textContent = 'Photos';
        dialog.setAttribute('aria-labelledby', title.id);

        const count = document.createElement('p');
        count.className = 'gallery__count';

        const picker = document.createElement('select');
        picker.className = 'gallery__order';
        picker.setAttribute('aria-label', 'Order the photographs');

        for (const [value, label] of ORDERS) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            picker.append(option);
        }

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'gallery__close';
        close.setAttribute('aria-label', 'Close the photos');
        close.textContent = '\u00d7';
        close.addEventListener('click', () => dialog.close());

        const head = document.createElement('div');
        head.className = 'gallery__head';
        head.append(title, count, picker, close);

        const body = document.createElement('div');
        body.className = 'gallery__body';

        picker.addEventListener('change', () => {
            order = picker.value;
            fill();
            body.scrollTop = 0;
        });

        // Delegated. Six hundred thumbnails is six hundred listeners
        // otherwise, and the grid is rebuilt every time the order changes.
        body.addEventListener('click', (event) => {
            const cell = event.target.closest?.('.gallery__cell');
            if (!cell || !body.contains(cell)) return;
            openViewer(Number(cell.dataset.at));
        });

        // Emptied on close rather than kept: an owner can add pictures to a
        // letter while the page is open, and rebuilding is cheaper than
        // working out what changed.
        dialog.addEventListener('close', () => {
            gallery.frames = [];
            gallery.cells = [];
            body.replaceChildren();
        });

        dialog.append(head, body);
        document.body.append(dialog);

        gallery = {
            dialog, title, count, picker, body,
            frames: [], cells: [], reveal: null, source: null
        };

        return gallery;
    }

    function fill() {
        const { posts, photoSrc } = gallery.source;
        const { blocks, frames } = planOf(posts, photoSrc, order);

        gallery.frames = frames;
        gallery.cells = new Array(frames.length);

        const built = document.createDocumentFragment();

        for (const block of blocks) {
            if (block.post) {
                const heading = document.createElement('h3');
                heading.className = 'gallery__day';
                heading.textContent = titleOf(block.post);
                built.append(heading);
            }

            const grid = document.createElement('ul');
            grid.className = 'gallery__grid';

            for (const frame of block.frames) {
                const img = document.createElement('img');
                img.src = frame.thumb;
                img.alt = '';
                // The whole point of the rewrite. The browser fetches what is
                // on screen and nothing else, which needs no code here and no
                // window to keep track of, and it goes on being true at six
                // hundred thumbnails.
                img.loading = 'lazy';
                img.decoding = 'async';

                // A button rather than a bare image, so it is reachable by
                // keyboard and announces itself as something that opens.
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'gallery__cell';
                cell.dataset.at = String(frame.at);
                cell.setAttribute('aria-label', `Photograph ${frame.at + 1}`);
                cell.append(img);

                const item = document.createElement('li');
                item.append(cell);
                grid.append(item);

                gallery.cells[frame.at] = cell;
            }

            built.append(grid);
        }

        gallery.body.replaceChildren(built);
        gallery.count.textContent =
            frames.length === 1 ? '1 photograph' : `${frames.length} photographs`;
    }

    function openViewer(at) {
        const view = ensureViewer();
        view.frames = gallery.frames;

        // Stopped, every time. Somebody who wants the slideshow presses Play;
        // somebody who clicked a thumbnail wanted that thumbnail.
        view.playing = false;
        view.play.textContent = 'Play';

        view.dialog.showModal();
        show(at);
    }

    /**
     * Open the album.
     *
     * @param {object} options
     * @param {Array} options.posts        the presented posts, newest first
     * @param {Function} options.photoSrc  (photoId, size) => url
     * @param {Function} options.reveal    hand a post id back to the page
     */
    function open({ posts, photoSrc, reveal }) {
        if (!posts.some((post) => post.photos?.length)) return;

        const view = ensureGallery();
        view.source = { posts, photoSrc };
        view.reveal = reveal;

        // Whose photographs these are, taken off the page rather than passed
        // in: `reader.js` also runs in the downloaded archive, which has no
        // album, and threading a website-only label through it to get here
        // would put the coupling in the wrong file.
        const name = document.getElementById('site-title')?.textContent?.trim();
        view.title.textContent = name || 'Photos';
        view.picker.value = order;

        fill();
        view.dialog.showModal();
        view.body.scrollTop = 0;
    }

    return { open };
})();
