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

    function framesOf(posts, photoSrc, how) {
        // Posts arrive newest first. Reversing whole letters rather than the
        // finished list keeps the pictures inside one letter in the order they
        // were written around.
        const ordered = how === 'newest' ? posts : [...posts].reverse();
        const frames = [];

        for (const post of ordered) {
            for (const photo of post.photos ?? []) {
                frames.push({
                    id: photo.id,
                    post,
                    src: photoSrc(photo.id, 'large'),
                    thumb: photoSrc(photo.id, 'thumb')
                });
            }
        }

        if (how !== 'random') return frames;

        for (let i = frames.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [frames[i], frames[j]] = [frames[j], frames[i]];
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

        const picker = document.createElement('select');
        picker.className = 'reel__order';
        picker.setAttribute('aria-label', 'Order the photographs');

        for (const [value, label] of ORDERS) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            picker.append(option);
        }

        picker.value = order;

        const head = document.createElement('div');
        head.className = 'reel__head';
        head.append(title, picker, close);

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

        const stripWrapper = document.createElement('div');
        stripWrapper.className = 'swiper-wrapper';

        const strip = document.createElement('div');
        strip.className = 'swiper reel__strip';
        strip.append(stripWrapper);

        // The caption is one element updated on each slide rather than one per
        // slide, because it holds a button and a thousand-photo archive should
        // not build a thousand of those.
        const caption = document.createElement('p');
        caption.className = 'reel__caption';

        const goTo = document.createElement('button');
        goTo.type = 'button';
        goTo.className = 'button button--quiet button--compact reel__goto';
        goTo.textContent = 'Go to this letter';

        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'button button--quiet button--compact reel__play';
        play.textContent = 'Play';
        play.addEventListener('click', () => {
            const autoplay = reel.swiper?.autoplay;
            if (!autoplay) return;
            autoplay.running ? autoplay.stop() : autoplay.start();
        });

        const foot = document.createElement('div');
        foot.className = 'reel__foot';
        foot.append(caption, play, goTo);

        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') dialog.close();
        });

        // Swiper fills the dialog, so a click on the dark gutter is reported
        // against the slide rather than the dialog and the usual test for a
        // backdrop click never fires. Handled from Swiper's own click event
        // instead, in `build`.
        dialog.append(head, stage, strip, foot);
        document.body.append(dialog);

        reel = {
            dialog, stage, wrapper, strip, stripWrapper, caption, goTo, play, picker, title,
            controls: { previous, next, counter },
            swiper: null, thumbs: null, frames: [], reveal: null, source: null
        };

        picker.addEventListener('change', () => {
            order = picker.value;
            if (!reel.source) return;

            // Re-sorted around the picture on screen rather than back to the
            // start, because the reader is looking at something and asking for
            // the rest of the album to be arranged differently around it.
            const at = reel.frames[reel.swiper?.activeIndex ?? 0]?.id;
            const playing = reel.swiper?.autoplay?.running ?? true;

            teardown(reel);
            build(reel, at);

            // A rebuilt slideshow starts itself. Somebody who had stopped it
            // asked for a different order, not for it to start running again.
            if (!playing) reel.swiper.autoplay.stop();
        });

        goTo.addEventListener('click', () => {
            const frame = reel.frames[reel.swiper?.activeIndex ?? 0];
            if (!frame) return;
            dialog.close();
            reel.reveal?.(frame.post.id);
        });

        // Destroyed on close rather than kept: an owner can add pictures to a
        // letter while the page is open, and rebuilding is cheaper than
        // working out what changed.
        dialog.addEventListener('close', () => teardown(reel));

        return reel;
    }

    function teardown(view) {
        view.swiper?.destroy(true, true);
        view.thumbs?.destroy(true, true);
        view.swiper = null;
        view.thumbs = null;
        view.wrapper.replaceChildren();
        view.stripWrapper.replaceChildren();
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

    function thumbFor(frame) {
        const img = document.createElement('img');
        img.src = frame.thumb;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';

        const slide = document.createElement('div');
        slide.className = 'swiper-slide';
        slide.append(img);

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
     * Fill the dialog and start Swiper, at whichever picture is named.
     *
     * Called on open and again whenever the order changes, which is why it
     * takes a photo id rather than an index -- an index means nothing once the
     * album has been re-sorted underneath it.
     */
    function build(view, at) {
        const { posts, photoSrc } = view.source;

        view.frames = framesOf(posts, photoSrc, order);
        view.wrapper.replaceChildren(...view.frames.map(slideFor));
        view.stripWrapper.replaceChildren(...view.frames.map(thumbFor));

        const start = at ? view.frames.findIndex((frame) => frame.id === at) : 0;

        // Built first, because the slider below is handed this one as an
        // option and Swiper wants the instance, not a selector to find later.
        view.thumbs = new Swiper(view.strip, {
            slidesPerView: 'auto',
            spaceBetween: 8,
            freeMode: true,
            slideToClickedSlide: true,
            // What tells the strip which thumbnail is the current one, so the
            // stylesheet has something to mark.
            watchSlidesProgress: true
        });

        view.swiper = new Swiper(view.stage, {
            initialSlide: Math.max(start, 0),
            // A deck rather than a strip. The pictures came in an envelope one
            // at a time, and a stack of them with the next one showing at the
            // edge is closer to how they were looked at than a filmstrip is.
            effect: 'cards',
            cardsEffect: { perSlideOffset: 9, perSlideRotate: 2, slideShadows: true },
            grabCursor: true,
            lazyPreloadPrevNext: 1,
            navigation: { prevEl: view.controls.previous, nextEl: view.controls.next },
            // A fraction rather than bullets. An archive runs to hundreds of
            // photographs and a row of hundreds of dots says nothing; "34 / 212"
            // says both where you are and how much there is.
            pagination: { el: view.controls.counter, type: 'fraction' },
            thumbs: { swiper: view.thumbs },
            keyboard: { enabled: true },
            zoom: { maxRatio: 4 },
            // Running from the moment it opens. Interaction does not cancel
            // it, because reaching for the arrow to skip one picture is not a
            // request to end the slideshow.
            autoplay: { delay: 4000, disableOnInteraction: false },
            on: {
                slideChange: () => describe(view),
                autoplayStart: () => { view.play.textContent = 'Pause'; },
                // Also fires on its own at the last picture, which is the
                // reason the label is driven from the event rather than set
                // beside the call that started it.
                autoplayStop: () => {
                    view.play.textContent = 'Play';
                    view.play.style.setProperty('--fill', 0);
                },
                // Swiper counts the delay down a frame at a time and reports
                // what is left as 1 down to 0. Turned round, that is how far
                // the fill across the button has got.
                autoplayTimeLeft: (swiper, left, remaining) => {
                    view.play.style.setProperty('--fill', 1 - remaining);
                },
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
        if (!posts.some((post) => post.photos?.length)) return;

        try {
            await loadSwiper();
        } catch {
            // Nothing to say and nowhere to say it. The pictures are all still
            // in the letters, which is where this reader came from.
            return;
        }

        const view = ensureReel();
        view.source = { posts, photoSrc };
        view.reveal = reveal;

        // Whose photographs these are, taken off the page rather than passed
        // in: `reader.js` also runs in the downloaded archive, which has no
        // album, and threading a website-only label through it to get here
        // would put the coupling in the wrong file.
        const name = document.getElementById('site-title')?.textContent?.trim();
        view.title.textContent = name || 'Photos';

        // Shown before Swiper measures: a slide inside a closed dialog has no
        // width, and every position it works out would be zero.
        view.dialog.showModal();

        build(view, at);
    }

    return { open };
})();
