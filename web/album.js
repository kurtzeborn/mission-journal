// Every photo in the archive, as one slideshow.
//
// The website only. The downloaded zip is not given this file and falls back
// to the reader's own lightbox, which shows one picture at a time -- the album
// is where video will live, video is not going in the download, and the bundle
// this leans on is larger than everything else the site serves put together.
//
// The archive is a list of dates. The word cloud is a view of the same letters
// by what is in them; this is a view of them by what was photographed. Both
// open over the top rather than replacing anything, and both hand the reader
// back to a single letter when they find the one they were looking for -- that
// is the whole reason a picture is worth clicking here rather than in a folder
// of images.
//
// The sliding, the pinch-zoom, the arrows, the counter and the keyboard are
// Swiper's. What is written here is the dialog around it, the caption, and the
// way back to the letter.

/* global Swiper, Reader */

window.Album = (function () {
    'use strict';

    const SWIPER_JS = '/vendor/swiper-bundle.min.js';
    const SWIPER_CSS = '/vendor/swiper-bundle.min.css';

    // Fetched on first open, not by a script tag in the page. Most readers
    // never open the album, and the ones who do have already decided to wait
    // for photographs.
    let ready = null;

    function loadSwiper() {
        if (ready) return ready;

        ready = new Promise((resolve, reject) => {
            if (window.Swiper) return resolve();

            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = SWIPER_CSS;

            const js = document.createElement('script');
            js.src = SWIPER_JS;
            js.addEventListener('load', () => resolve());
            js.addEventListener('error', () => reject(new Error('Swiper did not load')));

            document.head.append(css, js);
        });

        // A dropped connection must not be remembered as a permanent no.
        ready.catch(() => { ready = null; });

        return ready;
    }

    // Newest first, matching the list behind it. A photo album read forwards is
    // arguably the better story, but a reader who opens this from a letter and
    // then swipes should move through the archive in the direction the page
    // has already taught them.
    function framesOf(posts, photoSrc) {
        const frames = [];

        for (const post of posts) {
            for (const photo of post.photos ?? []) {
                frames.push({ id: photo.id, post, src: photoSrc(photo.id, 'large') });
            }
        }

        return frames;
    }

    let reel = null;

    function ensureReel() {
        if (reel) return reel;

        const dialog = document.createElement('dialog');
        dialog.className = 'reel';

        const title = document.createElement('h2');
        title.className = 'reel__title';
        title.id = 'reel-title';
        title.textContent = 'Photos';
        dialog.setAttribute('aria-labelledby', title.id);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'reel__close';
        close.setAttribute('aria-label', 'Close the photos');
        close.textContent = '\u00d7';
        close.addEventListener('click', () => dialog.close());

        const head = document.createElement('div');
        head.className = 'reel__head';
        head.append(title, close);

        const wrapper = document.createElement('div');
        wrapper.className = 'swiper-wrapper';

        const previous = document.createElement('div');
        previous.className = 'swiper-button-prev';

        const next = document.createElement('div');
        next.className = 'swiper-button-next';

        const counter = document.createElement('div');
        counter.className = 'swiper-pagination';

        const stage = document.createElement('div');
        stage.className = 'swiper reel__stage';
        stage.append(wrapper, previous, next, counter);

        // The caption is one element updated on each slide rather than one per
        // slide, because it holds a button and a thousand-photo archive should
        // not build a thousand of those.
        const caption = document.createElement('p');
        caption.className = 'reel__caption';

        const goTo = document.createElement('button');
        goTo.type = 'button';
        goTo.className = 'button button--quiet button--compact reel__goto';
        goTo.textContent = 'Go to this letter';

        const foot = document.createElement('div');
        foot.className = 'reel__foot';
        foot.append(caption, goTo);

        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') dialog.close();
        });

        // Swiper fills the dialog, so a click on the dark gutter is reported
        // against the slide rather than the dialog and the usual test for a
        // backdrop click never fires. Handled from Swiper's own click event
        // instead, in `open`.
        dialog.append(head, stage, foot);
        document.body.append(dialog);

        reel = {
            dialog, stage, wrapper, caption, goTo,
            controls: { previous, next, counter },
            swiper: null, frames: [], reveal: null
        };

        goTo.addEventListener('click', () => {
            const frame = reel.frames[reel.swiper?.activeIndex ?? 0];
            if (!frame) return;
            dialog.close();
            reel.reveal?.(frame.post.id);
        });

        // Destroyed on close rather than kept: an owner can add pictures to a
        // letter while the page is open, and rebuilding is cheaper than
        // working out what changed.
        dialog.addEventListener('close', () => {
            reel.swiper?.destroy(true, true);
            reel.swiper = null;
            reel.wrapper.replaceChildren();
        });

        return reel;
    }

    function slideFor(frame) {
        const img = document.createElement('img');
        img.src = frame.src;
        img.alt = '';
        // Native lazy loading rather than a library's. Swiper puts every slide
        // in the document, so `lazyPreloadPrevNext` below is what decides how
        // far ahead the browser is allowed to run.
        img.loading = 'lazy';
        img.decoding = 'async';

        // The wrapper is not decoration: Swiper's zoom scales this element, and
        // without it there is nothing to pinch.
        const zoom = document.createElement('div');
        zoom.className = 'swiper-zoom-container';
        zoom.append(img);

        const slide = document.createElement('div');
        slide.className = 'swiper-slide';
        slide.append(zoom);

        return slide;
    }

    function describe(view) {
        const frame = view.frames[view.swiper?.activeIndex ?? 0];
        if (!frame) return;

        const date = Reader.formatDate(frame.post.originalDate);
        const subject = frame.post.subject || 'Untitled';
        view.caption.textContent = date ? `${subject} \u2014 ${date}` : subject;
    }

    /**
     * Open the album, optionally at one particular picture.
     *
     * @param {object} options
     * @param {Array} options.posts        the presented posts, newest first
     * @param {Function} options.photoSrc  (photoId, size) => url
     * @param {Function} options.reveal    hand a post id back to the page
     * @param {string} [options.at]        a photo id to start on
     */
    async function open({ posts, photoSrc, reveal, at }) {
        const frames = framesOf(posts, photoSrc);
        if (!frames.length) return;

        try {
            await loadSwiper();
        } catch {
            // Nothing to say and nowhere to say it. The pictures are all still
            // in the letters, which is where this reader came from.
            return;
        }

        const view = ensureReel();
        view.frames = frames;
        view.reveal = reveal;

        view.wrapper.replaceChildren(...frames.map(slideFor));

        // Shown before Swiper measures: a slide inside a closed dialog has no
        // width, and every position it works out would be zero.
        view.dialog.showModal();

        const start = at ? frames.findIndex((frame) => frame.id === at) : 0;

        view.swiper = new Swiper(view.stage, {
            initialSlide: Math.max(start, 0),
            spaceBetween: 24,
            lazyPreloadPrevNext: 1,
            navigation: { prevEl: view.controls.previous, nextEl: view.controls.next },
            // A fraction rather than bullets. An archive runs to hundreds of
            // photographs and a row of hundreds of dots says nothing; "34 / 212"
            // says both where you are and how much there is.
            pagination: { el: view.controls.counter, type: 'fraction' },
            keyboard: { enabled: true },
            zoom: { maxRatio: 4 },
            on: {
                slideChange: () => describe(view),
                // Tap the picture to zoom, tap the dark around it to leave --
                // which is what the lightbox this replaces did, and what every
                // other viewer does.
                click(swiper, event) {
                    if (event.target.closest('.swiper-zoom-container')) swiper.zoom.toggle();
                    else view.dialog.close();
                }
            }
        });

        describe(view);
    }

    return { open };
})();
