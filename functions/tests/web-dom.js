// A DOM small enough to run the site's own scripts against.
//
// `web/people.js` and `web/invite.js` are the two files that decide what a
// person is shown when something goes wrong -- which invitations were refused
// and why, whether a link is expired or withdrawn, which account is about to
// be granted access. Every one of those is a sentence somebody reads at the
// moment they are already confused, and until now none of them were tested at
// all: the whole of `web/` had no harness.
//
// The alternative was a headless browser, which means a dependency, a download
// on every CI run, and a class of flake that has nothing to do with the code
// under test. What these two files actually touch is a dozen DOM methods, so
// this implements those and runs the real, unmodified script in `node:vm`.
//
// The trade is stated rather than hidden: this proves the logic and the words,
// not the rendering. A stylesheet that hides the panel, a mistyped element id
// in the HTML -- neither is caught here. What is caught is every branch that
// decides what those elements are *told to say*, which is where the bugs that
// reach a person live.

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class TextNode {
    constructor(text) {
        this.textContent = String(text);
    }
}

class Element {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.hidden = false;
        this.disabled = false;
        this.className = '';
        this.href = '';
        this.value = '';
        this.type = '';
        this.attributes = new Map();
        this.listeners = new Map();
        this.classList = {
            added: [],
            add: (...names) => this.classList.added.push(...names)
        };
    }

    // Attributes the markup wrote and the script may take back. `role="timer"`
    // on a clock that has stopped is the case this exists for: it is a
    // promise to a screen reader that the number is still moving.
    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    // Text lives in child nodes, exactly as it does in a browser. It matters:
    // people.js sets textContent and *then* appends, and an implementation
    // that stored the string on the element would silently drop the first
    // half of every row.
    get textContent() {
        return this.children.map((child) => child.textContent).join('');
    }

    set textContent(value) {
        this.children = value === '' ? [] : [new TextNode(value)];
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    // Needed by manage.js, which redraws its whole table after a restore
    // rather than surgically editing a row. The distinction from setting
    // textContent to '' matters: this drops element children too, and a
    // version that only cleared text would leave every previous row's buttons
    // still wired to a fetch.
    replaceChildren(...nodes) {
        this.children = nodes;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }

    /** Fire the handlers a browser would, and wait for the async ones. */
    async dispatch(type, event = {}) {
        const handlers = this.listeners.get(type) ?? [];
        for (const handler of handlers) await handler({ preventDefault() {}, ...event });
    }

    /** Every descendant, for finding the button whose label reads a given way. */
    descendants() {
        return this.children.flatMap((child) =>
            child instanceof Element ? [child, ...child.descendants()] : []
        );
    }

    // The elements here are a flat map keyed by id rather than a tree, so this
    // answers for the ones a script built itself -- which is what a menu
    // closing on a click somewhere else needs to ask.
    contains(node) {
        return node === this || this.descendants().includes(node);
    }
}

/**
 * The ids and sections the real markup provides.
 *
 * Regex over HTML is normally a mistake. It is not one here, because the input
 * is our own hand-written file and the only question being asked of it is
 * "which ids exist and which start hidden" -- and because the alternative was
 * a list of ids kept by hand in the test, which would drift from the markup
 * and drift in the one direction that matters: staying green after somebody
 * renames an element and breaks the page.
 */
function markup(file) {
    const source = readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8')
        // Comments first. The explanatory ones in these files quote element
        // names, and a commented-out id is not an id.
        .replace(/<!--[\s\S]*?-->/g, '');

    const ids = new Map();
    let sections = 0;

    for (const [, tag, attrs] of source.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
        if (tag.toLowerCase() === 'section') sections++;
        const id = attrs.match(/\bid="([^"]+)"/)?.[1];
        // Quoted values are emptied before looking for the bare `hidden` and
        // `disabled` attributes, so `class="visually-hidden"` cannot be
        // mistaken for one.
        const bare = attrs.replace(/"[^"]*"/g, '""');
        if (id) {
            ids.set(id, {
                hidden: /\bhidden\b/.test(bare),
                // Carried for the same reason as `hidden`: a control that
                // starts disabled in the markup and is armed by script is only
                // safe if it really does start that way, and a test that set
                // the initial state itself could never notice the attribute
                // being dropped.
                disabled: /\bdisabled\b/.test(bare),
                attrs: new Map(
                    [...attrs.matchAll(/\b([\w-]+)="([^"]*)"/g)].map(([, name, v]) => [name, v])
                )
            });
        }
    }

    return { ids, sections, source };
}

/**
 * A page, built from the file the browser would load.
 *
 * Asking for an element the markup does not have throws rather than returning
 * null, because that failure -- a script reaching for an id the HTML lost in a
 * rename -- is a real bug and should be loud.
 */
export function page({ html, path = '/', hash = '' }) {
    const { ids, sections, source } = markup(html);

    const elements = new Map();
    for (const [id, start] of ids) {
        const element = new Element('div');
        element.hidden = start.hidden;
        element.disabled = start.disabled;
        for (const [name, value] of start.attrs) element.setAttribute(name, value);
        elements.set(id, element);
    }

    const sectionElements = Array.from({ length: sections }, () => new Element('section'));

    const documentListeners = new Map();

    const document = {
        // Taken from the markup rather than defaulted, so a test can assert
        // what a page discloses before its script has decided who is asking.
        title: source.match(/<title>([\s\S]*?)<\/title>/i)?.[1].trim() ?? '',
        getElementById(id) {
            if (!elements.has(id)) throw new Error(`no element with id "${id}"`);
            return elements.get(id);
        },
        createElement: (tagName) => new Element(tagName),
        createTextNode: (text) => new TextNode(text),
        // For the handlers a page attaches to the whole document rather than to
        // one element -- closing an open menu when the click landed elsewhere.
        addEventListener(type, handler) {
            if (!documentListeners.has(type)) documentListeners.set(type, []);
            documentListeners.get(type).push(handler);
        },
        querySelectorAll: (selector) =>
            selector === 'main > section' ? sectionElements : []
    };

    const storage = new Map();

    const context = {
        document,
        location: {
            pathname: path,
            hash,
            href: path,
            assign(target) {
                this.href = target;
            },
            // Distinct from `assign`, because the difference is the whole
            // reason a script picks one: `replace` leaves no history entry, so
            // Back cannot return to the page. Recorded separately so a test can
            // assert that a page nobody should be able to go back to used it.
            replace(target) {
                this.href = target;
                this.replaced = target;
            }
        },
        // A real `replaceState` rewrites the address bar, fragment included,
        // and scripts here call it precisely to get rid of a token. A no-op
        // would let a script that forgot to strip the fragment pass.
        history: {
            replaceState(state, title, url) {
                const target = String(url ?? '');
                const cut = target.indexOf('#');
                context.location.pathname = cut === -1 ? target : target.slice(0, cut);
                context.location.hash = cut === -1 ? '' : target.slice(cut);
                context.location.href = target;
            }
        },
        sessionStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        },
        // Recorded rather than scheduled. The archive page runs a clock, and a
        // test that waits for a real one is a test whose result depends on how
        // busy the machine is. Handing the callback back lets a test say
        // "now a second has passed" and mean it.
        timers: [],
        setInterval(handler, every) {
            context.timers.push({ handler, every, cleared: false });
            return context.timers.length;
        },
        clearInterval(id) {
            const timer = context.timers[id - 1];
            if (timer) timer.cleared = true;
        },
        confirmed: true,
        console
    };

    context.window = context;
    // The site's own dialog, stubbed to the answer a test asked for. It draws
    // itself into a page this DOM does not have, and the question under test
    // is only ever which branch the answer took.
    context.Confirm = { ask: async () => context.confirmed };
    context.self = context;

    return {
        context,
        elements,
        sections: sectionElements,
        // The markup itself, comments stripped. For asserting on wording that
        // is written into the page rather than rendered by a script -- the
        // element map has no tree, so a section's static prose is not
        // reachable through `text`.
        source,
        el: (id) => document.getElementById(id),
        text: (id) => document.getElementById(id).textContent,
        /** Fire a handler the page attached to the document itself. */
        elsewhere: async (type, target = new Element('div')) => {
            for (const handler of documentListeners.get(type) ?? []) {
                await handler({ preventDefault() {}, target });
            }
        },
        /** The rendered lines of a list, one string per child. */
        lines: (id) => document.getElementById(id).children.map((c) => c.textContent),
        /** A descendant button by the words on it, for clicking. */
        button: (id, label) =>
            document
                .getElementById(id)
                .descendants()
                .find((node) => node.tagName === 'button' && node.textContent === label),
        /** A descendant link by the words on it, for reading its href. */
        link: (id, label) =>
            document
                .getElementById(id)
                .descendants()
                .find((node) => node.tagName === 'a' && node.textContent === label)
    };
}

/**
 * A `fetch` that answers from a script and records what it was asked.
 *
 * `answer` is called with (url, init) and returns `{ status, body }`, or throws
 * to model the network being down -- which is a branch both files handle and
 * neither had ever had exercised.
 */
export function fetching(answer) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
        const reply = await answer(url, init, calls.length);
        if (reply instanceof Error) throw reply;
        const { status = 200, body = {}, headers = {} } = reply ?? {};
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => headers[name] ?? null },
            json: async () => body
        };
    };
    return { fetch, calls };
}

/**
 * Run one of the site's scripts against a page.
 *
 * The file is read and executed unmodified, so the thing under test is the
 * thing that ships. Both scripts start work as they load, and both start it
 * with an await, so one turn of the microtask queue is not enough -- callers
 * await `settled()` to let the whole chain finish.
 *
 * Takes a list when the page loads a shared script first, in the order the
 * markup loads them.
 */
export function run(files, { context, fetch }) {
    context.fetch = fetch;
    for (const file of [files].flat()) {
        const source = readFileSync(new URL(`../../web/${file}`, import.meta.url), 'utf8');
        runInNewContext(source, context, { filename: file });
    }
}

/** Let every pending promise chain finish. */
export const settled = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
};
