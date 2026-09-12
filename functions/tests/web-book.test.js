import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fetching, page, run, settled } from './web-dom.js';

const html = readFileSync(new URL('../../web/book.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
const script = readFileSync(new URL('../../web/book.js', import.meta.url), 'utf8');

describe('the finished book actions', () => {
    test('describes the keepsake, hidden letters, and optional content', () => {
        assert.match(html, /hardcover book which serves as a personalized missionary\s+keepsake/);
        assert.match(html, /Letters marked as hidden in the archive are not included in the book/);
        assert.match(html, /Optional book-only content/);
        assert.match(html, /Foreword and Afterword sections are optional/);
        assert.ok(html.indexOf('The cover') < html.indexOf('Optional book-only content'));
    });

    test('offers the proof and keeps the print file hidden by default', () => {
        assert.match(html, />View proof<\/a>/);
        assert.match(html, /id="print"[^>]*hidden[^>]*>Download print file<\/a>/);
    });

    describe('Foreword and Afterword controls', () => {
        const open = async (initial = { foreword: null, afterword: null }) => {
            let saved = { ...initial };
            const view = page({ html: 'book.html', path: '/book/elder.example' });
            const net = fetching(async (url, init) => {
                if (url.endsWith('/cover')) return { status: 404 };
                if (url.endsWith('/sections')) return { body: saved };
                if (url.includes('/sections/')) {
                    const name = url.split('/').at(-1);
                    if (init.method === 'DELETE') saved = { ...saved, [name]: null };
                    else saved = { ...saved, [name]: JSON.parse(init.body).bodyHtml };
                    return { body: saved };
                }
                return { status: 404 };
            });
            run('book.js', { context: view.context, fetch: net.fetch });
            await settled();
            return { view, net };
        };

        test('offers Create only while a section is absent', async () => {
            const { view } = await open();

            assert.equal(view.el('foreword-create').hidden, false);
            assert.equal(view.el('foreword-view').hidden, true);
            assert.equal(view.el('foreword-delete').hidden, true);
            assert.equal(view.el('afterword-create').hidden, false);
            assert.match(view.source, /Foreword is often most meaningful when written by a parent or friend/i);
        });

        test('Create opens the shared modal directly in rich-text edit mode and saves', async () => {
            const { view, net } = await open();
            await view.el('foreword-create').dispatch('click');

            assert.equal(view.el('book-part-dialog').open, true);
            assert.equal(view.el('book-part-title').textContent, 'Foreword');
            assert.equal(view.el('book-part-editor').getAttribute('contenteditable'), 'true');
            assert.equal(view.el('book-part-edit').hidden, true);

            view.el('book-part-editor').innerHTML = '<p>From Mum.</p>';
            await view.el('book-part-save').dispatch('click');
            await settled();

            const saved = net.calls.find((call) => call.method === 'PUT');
            assert.deepEqual(saved.body, { bodyHtml: '<p>From Mum.</p>' });
            assert.equal(view.el('book-part-dialog').open, false);
            assert.equal(view.el('foreword-create').hidden, true);
            assert.equal(view.el('foreword-view').hidden, false);
        });

        test('View opens read-only and offers Edit and Delete', async () => {
            const { view } = await open({ foreword: '<p>From a friend.</p>', afterword: null });
            await view.el('foreword-view').dispatch('click');

            assert.equal(view.el('book-part-editor').innerHTML, '<p>From a friend.</p>');
            assert.equal(view.el('book-part-editor').getAttribute('contenteditable'), null);
            assert.equal(view.el('book-part-edit').hidden, false);
            assert.equal(view.el('book-part-modal-delete').hidden, false);

            await view.el('book-part-edit').dispatch('click');
            assert.equal(view.el('book-part-editor').getAttribute('contenteditable'), 'true');
        });

        test('Escape cancels an edit instead of letting the dialog discard it implicitly', async () => {
            const { view } = await open({ foreword: '<p>From a friend.</p>', afterword: null });
            await view.el('foreword-view').dispatch('click');
            await view.el('book-part-edit').dispatch('click');
            view.el('book-part-editor').innerHTML = '<p>Unsaved.</p>';

            await view.el('book-part-dialog').dispatch('cancel');

            assert.equal(view.el('book-part-dialog').open, true);
            assert.equal(view.el('book-part-editor').innerHTML, '<p>From a friend.</p>');
            assert.equal(view.el('book-part-editor').getAttribute('contenteditable'), null);
        });

        test('uses the letter editor formatting shortcuts', async () => {
            const { view } = await open();
            const commands = [];
            view.context.document.execCommand = (command) => commands.push(command);
            await view.el('afterword-create').dispatch('click');
            await view.el('book-part-editor').dispatch('keydown', {
                key: 'b',
                ctrlKey: true,
                metaKey: false,
                altKey: false
            });

            assert.deepEqual(commands, ['styleWithCSS', 'bold']);
        });

        test('page Delete uses Confirm and does nothing when it is cancelled', async () => {
            const { view, net } = await open({ foreword: null, afterword: '<p>Home.</p>' });
            view.context.confirmed = false;
            await view.el('afterword-delete').dispatch('click');

            assert.match(view.context.asked.question, /Delete the Afterword/);
            assert.equal(net.calls.some((call) => call.method === 'DELETE'), false);
            assert.equal(view.el('afterword-view').hidden, false);
        });

        test('modal Delete uses Confirm before removing the section', async () => {
            const { view, net } = await open({ foreword: '<p>Hello.</p>', afterword: null });
            await view.el('foreword-view').dispatch('click');
            await view.el('book-part-modal-delete').dispatch('click');
            await settled();

            assert.match(view.context.asked.detail, /cannot be undone/i);
            assert.ok(net.calls.some((call) => call.method === 'DELETE'));
            assert.equal(view.el('book-part-dialog').open, false);
            assert.equal(view.el('foreword-create').hidden, false);
        });
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
