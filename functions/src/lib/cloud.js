// The site's word cloud, laid out for print.
//
// The reader has drawn a cloud since the archive shipped, using wordcloud2 in
// the browser. The book prints the same one, and "the same one" is meant
// literally: this runs that library -- the same vendored file that goes out in
// the downloadable archive, unmodified -- rather than reimplementing its
// packing. An earlier version of this file did reimplement it, badly. The
// library nests words into the notches of their neighbours by rasterising each
// one and reading the pixels back, and a bounding-box packer does not come
// close; the page it produced looked like a printing fault.
//
// What is different from the browser is only what has to be. wordcloud2 needs
// somewhere to rasterise, and Node has no canvas, so it gets one from
// @napi-rs/canvas with the book's own font registered in it -- the same face
// pdfkit embeds, so the widths the packing works from are the widths the press
// will set. And it is asked for positions rather than pixels: in DOM mode the
// library reports each word as a span with a place, a size and a rotation,
// which is exactly the handoff a PDF needs, because the type has to be real
// embedded text and not a picture of text.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

// The face name the canvas will know it by. It only has to match what gets
// passed as `fontFamily` below; nothing outside this file sees it.
const FAMILY = 'Crimson Text Book';

let registered = false;
const registerFace = () => {
    if (registered) return;
    GlobalFonts.registerFromPath(
        fileURLToPath(new URL('../assets/book/CrimsonText-Regular.ttf', import.meta.url)),
        FAMILY
    );
    registered = true;
};

const SOURCE = readFileSync(new URL('../assets/reader/wordcloud2.js', import.meta.url), 'utf8');

// wordcloud2 turns a word on its side by drawing it rotated and reading the
// pixels back, so the browser's own settings are carried over verbatim from
// `web/reader.js`. Three words in ten go vertical, either way up, and the
// packing steps in six-point cells.
export const CLOUD = {
    gridSize: 6,
    rotateRatio: 0.3,
    rotationSteps: 2,
    minRotation: -Math.PI / 2,
    maxRotation: Math.PI / 2,
    shape: 'square',
    drawOutOfBound: false,
    shrinkToFit: true
};

/**
 * Where every word sits on the page.
 *
 * @param {[string, number][]} words commonest first
 * @param {object} box
 * @param {number} box.width in points
 * @param {number} box.height
 * @param {(count: number) => number} box.size point size for a count
 * @returns {{word: string, count: number, size: number, x: number, y: number, width: number, height: number, turn: number}[]}
 */
export function layoutCloud(words, { width, height, size }) {
    if (!words.length) return [];

    registerFace();

    const placed = [];
    const context = sandbox(words);
    runInContext(SOURCE, context, { filename: 'wordcloud2.js' });

    const box = {
        tagName: 'DIV',
        style: {},
        textContent: '',
        getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
        appendChild: (span) => placed.push(span),
        ...listeners()
    };

    context.WordCloud(box, {
        ...CLOUD,
        list: words.map(([word, count]) => ({ word, weight: count })),
        weightFactor: size,
        fontFamily: `"${FAMILY}"`,
        color: null,
        backgroundColor: 'transparent',
        // The one setting the page is not allowed to inherit. wordcloud2
        // squashes the cloud to 0.65 of its height by default, which is not a
        // taste -- it is the shape of the wide box a browser gives it, and the
        // reader's is exactly that shape. A book page is taller than it is
        // wide, and the default left a third of the leaf as white bands above
        // and below. Asking for the shape of the paper is the same decision
        // the default is making, made again for different paper.
        ellipticity: height / width,
        wait: 0
    });

    const counts = new Map(words);

    return placed.map((span) => ({
        word: span.textContent,
        count: counts.get(span.textContent) ?? 0,
        size: pixels(span.style.font.match(/([\d.]+)px/)[1]),
        x: pixels(span.style.left),
        y: pixels(span.style.top),
        width: pixels(span.style.width),
        height: pixels(span.style.height),
        turn: Number(span.style.transform.match(/rotate\((-?[\d.]+)deg\)/)[1])
    }));
}

const pixels = (value) => Number.parseFloat(value);

/**
 * Just enough browser for wordcloud2 and not one method more.
 *
 * The library is UMD and puts itself on the global when there is no `module`,
 * which is why this is a `vm` context rather than an import: it wants a window
 * to attach to and a document to make canvases from, and giving it a private
 * one is cheaper and safer than pretending this process is a browser.
 */
function sandbox(words) {
    const context = createContext({});

    context.window = context;
    context.self = context;
    context.Date = Date;

    // The loop is written to yield between words so a browser stays responsive.
    // Nothing here is waiting on a screen, and a synchronous `setImmediate`
    // turns the whole layout into one call that returns when it is done --
    // which keeps the book's two setting passes ordinary synchronous code.
    context.setImmediate = (fn) => {
        fn();
        return 0;
    };
    context.clearImmediate = () => {};
    context.setTimeout = context.setImmediate;
    context.clearTimeout = context.clearImmediate;

    // wordcloud2 rolls a die for each word's rotation. Left to `Math.random`
    // the same archive would print a different cloud every time it was bound,
    // including between the pass that measures the book and the pass that sets
    // it. Seeded off the words themselves, an archive gets one cloud, and it
    // gets the same one every time anybody asks for it again.
    context.Math = Object.create(Math);
    context.Math.random = dice(words.map(([word]) => word).join(' '));

    context.CustomEvent = class CustomEvent {
        constructor(type, options = {}) {
            this.type = type;
            this.detail = options.detail;
            this.cancelable = Boolean(options.cancelable);
            this.defaultPrevented = false;
        }

        preventDefault() {
            this.defaultPrevented = true;
        }
    };

    context.document = {
        createElement: (tag) => (tag === 'canvas' ? scratch() : { style: {}, setAttribute() {} }),
        body: { appendChild() {} }
    };

    return context;
}

// A canvas that answers to the few DOM calls wordcloud2 makes on one: it sizes
// them with setAttribute, which a bare @napi-rs canvas has never heard of.
function scratch() {
    const canvas = createCanvas(1, 1);

    return {
        get width() {
            return canvas.width;
        },
        get height() {
            return canvas.height;
        },
        setAttribute(name, value) {
            canvas[name] = Number(value);
        },
        getContext: (kind) => canvas.getContext(kind)
    };
}

function listeners() {
    const held = new Map();

    return {
        addEventListener(type, fn) {
            held.set(type, [...(held.get(type) ?? []), fn]);
        },
        removeEventListener(type, fn) {
            held.set(type, (held.get(type) ?? []).filter((each) => each !== fn));
        },
        dispatchEvent(event) {
            for (const fn of held.get(event.type) ?? []) fn(event);
            return !event.defaultPrevented;
        }
    };
}

// mulberry32, seeded by hashing the text. Any small deterministic generator
// would do; what matters is that it is not the platform's.
function dice(text) {
    let seed = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        seed = Math.imul(seed ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }

    return () => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
