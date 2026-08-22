// A real DOM for the one file in `web/` that needs one.
//
// `web-dom.js` next door implements a dozen methods by hand and runs the
// simple scripts against them. That worked because those files append rows to
// a list and set some text. `reader.js` does none of those things: it walks
// the letter with a TreeWalker to measure how much prose sits beside each
// photo, extracts a Range spanning several elements and reassembles what is
// left, parses stored HTML through a <template>, and unwraps its own
// decorations back into markup that goes to the server. Implementing that
// surface by hand is writing a DOM library, and a hand-written DOM that got
// Range.extractContents subtly wrong would agree with the tests and disagree
// with every browser.
//
// So this uses jsdom -- which is a dependency, and the plan said a dependency
// was the thing to avoid. Two of the three reasons it gave do not apply: there
// is no browser binary to download on every run, and there is no timing to be
// flaky about. What is left is one devDependency with no native code, against
// the alternative of shipping untested DOM surgery to an archive families
// cannot re-download if it breaks.
//
// The page is the real `web/site.html`, not a fixture. That is deliberate: the
// ids and the search form are the seam between the markup and this script, and
// a fixture would keep passing after somebody renamed one of them.

import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/**
 * What jsdom does not implement, supplied so the calls can be asserted on.
 *
 * Each of these is missing for the same reason: it does something to a screen,
 * and jsdom has no screen. Stubbing them is not papering over a gap -- the
 * question a test wants to ask is "was the lightbox told to open", "was the
 * hit scrolled to", "was bold applied", and a recorded call answers all three
 * better than a rendering would.
 */
function stubs(window, record) {
    const { HTMLDialogElement, Element, document } = window;

    HTMLDialogElement.prototype.showModal = function showModal() {
        this.setAttribute('open', '');
    };

    // The real close() fires a `close` event, and reader.js hangs the "drop
    // the photo out of memory" behaviour off it. A stub that only removed the
    // attribute would leave that line untested and a leak unnoticed.
    HTMLDialogElement.prototype.close = function close() {
        if (!this.hasAttribute('open')) return;
        this.removeAttribute('open');
        this.dispatchEvent(new window.Event('close'));
    };

    Element.prototype.scrollIntoView = function scrollIntoView(options) {
        record.scrolled.push({ node: this, options });
    };

    document.execCommand = (command, showUi, value) => {
        record.commands.push({ command, value });
        return true;
    };
}

/**
 * A loaded archive page with `Reader` on it, ready to mount.
 *
 * `app.js` is deliberately not run. It is the part that talks to the API and
 * decides who is looking, and it is a different file with different concerns;
 * what is under test here is what `reader.js` does once it has been handed
 * some letters. MiniSearch is run, because search is not a stub -- the
 * ranking, the prefix matching and the fuzziness are half of what the search
 * tests are about.
 */
export function page({ url = 'https://pdayletters.com/isaac.backman' } = {}) {
    const dom = new JSDOM(read('web/site.html'), { runScripts: 'outside-only', url });
    const { window } = dom;
    const record = { scrolled: [], commands: [] };

    stubs(window, record);

    const context = dom.getInternalVMContext();
    runInContext(read('web/vendor/minisearch.js'), context, { filename: 'minisearch.js' });
    runInContext(read('web/reader.js'), context, { filename: 'reader.js' });

    const { document } = window;
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => [...document.querySelectorAll(selector)];

    const elements = {
        list: document.getElementById('posts'),
        state: document.getElementById('state'),
        searchForm: document.getElementById('search'),
        searchInput: document.getElementById('q'),
        searchCount: document.getElementById('search-count')
    };

    return {
        window,
        document,
        elements,
        record,
        $,
        $$,

        /** Draw an archive. Same call the site and the zip both make. */
        mount: (options) => window.Reader.mount({ photoSrc, elements, ...options }),

        formatDate: (value) => window.Reader.formatDate(value),

        /** One letter's `<li>`, by post id. */
        post: (id) => $(`[data-post="${id}"]`),

        /** The letter bodies, in page order, as their rendered HTML. */
        bodies: () => $$('.post__body').map((body) => body.innerHTML),

        /** A button by the words on it, anywhere on the page. */
        button: (label) =>
            $$('button').find((el) => el.textContent === label && !el.hidden),

        /** Every button with these words, hidden ones included. */
        buttons: (label) => $$('button').filter((el) => el.textContent === label),

        /** Fire a click that bubbles, which is what the delegated handlers need. */
        click(node, init = {}) {
            node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
        },

        key(node, key, init = {}) {
            node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
        },

        /** Type into the search box the way a person does. */
        search(query) {
            elements.searchInput.value = query;
            elements.searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
        },

        lightbox: () => $('dialog.lightbox'),

        /** The photo currently on screen at full size, or null. */
        enlarged() {
            const dialog = $('dialog.lightbox');
            if (!dialog?.hasAttribute('open')) return null;
            return dialog.querySelector('img').getAttribute('src');
        }
    };
}

/** The hosted site's own scheme, which is also the simplest to assert on. */
export const photoSrc = (id, size) => `/api/photo/isaac.backman/${id}/${size}.webp`;

/** The src the sanitizer stores in `bodyHtml`, which is the same shape. */
export const stored = (id, size = 'small') => `/api/photo/isaac.backman/${id}/${size}.webp`;

/** An `<img>` as it appears in a letter that came out of the render pipeline. */
export const img = (id, size = 'small') => `<img src="${stored(id, size)}" alt="">`;

/**
 * A paragraph of a given length, in whole words.
 *
 * Length is the point: the reader floats a photo only when enough letter
 * follows it, so the tests need prose measured in characters rather than
 * prose that happens to be long. Padding with a repeated word keeps it
 * searchable too -- `para(400, 'Guatemala')` is both a measurement and a
 * search fixture.
 */
export function para(length, word = 'letter') {
    const unit = `${word} `;
    return `<p>${unit.repeat(Math.ceil(length / unit.length)).slice(0, length).trim()}</p>`;
}

/** A letter, with only the fields the reader actually reads. */
export function letter(id, bodyHtml, extra = {}) {
    return {
        id,
        originalDate: `${id.slice(0, 10)}T09:00:00`,
        subject: `Week of ${id.slice(0, 10)}`,
        bodyHtml,
        photos: [],
        hidden: false,
        ...extra
    };
}
