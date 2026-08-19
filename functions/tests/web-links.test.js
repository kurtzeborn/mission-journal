// Links inside the site's own pages.
//
// One narrow thing, and the reason it is worth a file: the questions page is
// organised as a list of links to anchors further down, and a broken one of
// those fails silently. Nothing errors, nothing looks wrong, the page simply
// does not move -- and the person it fails for is somebody who was sent there
// because they were already stuck.
//
// The same check covers links between pages that point at an anchor, because
// those break the same way and for the same reason: somebody renames a
// heading.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const WEB = new URL('../../web/', import.meta.url);

const pages = readdirSync(WEB).filter((name) => name.endsWith('.html'));
const read = (name) => readFileSync(new URL(name, WEB), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const idsIn = (source) => new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const hrefsIn = (source) => [...source.matchAll(/\bhref="([^"]+)"/g)].map((m) => m[1]);

describe('the questions page holds together', () => {
    const source = read('faq.html');

    test('every question in the contents points at a heading that exists', async () => {
        const ids = idsIn(source);
        const broken = hrefsIn(source)
            .filter((href) => href.startsWith('#'))
            .map((href) => href.slice(1))
            .filter((id) => !ids.has(id));

        assert.deepEqual(broken, []);
    });

    test('every question has an id, so it can be linked to from elsewhere', async () => {
        // The whole argument for anchors over collapsible panels. A question
        // without an id is one a refusal message cannot point at.
        const unnamed = [...source.matchAll(/<h3(?![^>]*\bid=)[^>]*>([\s\S]*?)<\/h3>/g)]
            .map((m) => m[1].replace(/<[^>]*>/g, '').trim())
            // The contents list uses h3 for its topic groups, which are
            // labels rather than questions and are not linked to.
            .filter((text) => !['General', 'Setting up', 'Access', 'Privacy', 'Printing'].includes(text));

        assert.deepEqual(unnamed, []);
    });

    test('the contents lists every question exactly once', async () => {
        // The failure this catches is a question added below and forgotten
        // above, which makes it unreachable for anyone who scans the list and
        // stops there.
        const linked = new Set(
            hrefsIn(source).filter((href) => href.startsWith('#')).map((href) => href.slice(1))
        );
        const questions = [...source.matchAll(/<h3 id="([^"]+)"/g)].map((m) => m[1]);

        const missing = questions.filter((id) => !linked.has(id));
        assert.deepEqual(missing, []);
        assert.equal(new Set(questions).size, questions.length);
    });
});

describe('links between pages', () => {
    test('no page links to an anchor another page does not have', async () => {
        const broken = [];

        for (const name of pages) {
            for (const href of hrefsIn(read(name))) {
                const [path, fragment] = href.split('#');
                if (!fragment || !path || path.startsWith('http') || path.startsWith('mailto:')) continue;

                // `/faq` and `/start` are rewrites of the matching file.
                const target = `${path.replace(/^\//, '') || 'index'}.html`;
                if (!pages.includes(target)) continue;

                if (!idsIn(read(target)).has(fragment)) broken.push(`${name} -> ${href}`);
            }
        }

        assert.deepEqual(broken, []);
    });
});
