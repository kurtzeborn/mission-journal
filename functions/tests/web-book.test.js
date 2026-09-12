import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fetching, page, run, settled } from './web-dom.js';

const html = readFileSync(new URL('../../web/book.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
const script = readFileSync(new URL('../../web/book.js', import.meta.url), 'utf8');

describe('the finished book actions', () => {
    test('offers the proof and keeps the print file hidden by default', () => {
        assert.match(html, />View proof<\/a>/);
        assert.match(html, /id="print"[^>]*hidden[^>]*>Download print file<\/a>/);
    });

    test('describes checkout fulfillment and ownership plainly', () => {
        assert.match(html, /Hardcover, printed, and shipped by our printer/);
        assert.match(html, /this book and its\s+contents are yours to print/);
        assert.doesNotMatch(html, /proof &middot; not for print/);
    });

    const open = async (operator, cover = null) => {
        const view = page({ html: 'book.html', path: '/book/elder.example' });
        const net = fetching(async (url) =>
            url.endsWith('/cover')
                ? cover
                    ? { body: cover }
                    : { status: 404 }
                : {
                      body: {
                          id: 'book-1',
                          state: 'ready',
                          builtAt: '2026-09-12T12:00:00.000Z',
                          pages: 24,
                          letters: 3,
                          printing: true,
                          operator
                      }
                  }
        );
        run('book.js', { context: view.context, fetch: net.fetch });
        await settled();
        return view;
    };

    test('shows the print file to an operator', async () => {
        const view = await open(true);

        assert.equal(view.el('print').hidden, false);
        assert.match(view.el('print').href, /\/letters\.pdf$/);
    });

    test('does not show the print file to an archive owner', async () => {
        const view = await open(false);

        assert.equal(view.el('print').hidden, true);
    });

    test('shows the mission dates on the cover preview', async () => {
        const view = await open(false, {
            title: 'Elder Example',
            mission: 'Example Mission',
            dates: 'July 1, 2024 \u2013 January 15, 2026',
            cloth: 'navy',
            picture: '',
            cloths: []
        });

        assert.equal(view.text('board-dates'), 'July 1, 2024 \u2013 January 15, 2026');
        assert.equal(view.el('board-dates').hidden, false);
    });
});
