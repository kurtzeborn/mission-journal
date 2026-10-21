import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fetching, page, run, settled } from './web-dom.js';

const script = readFileSync(new URL('../../web/book.js', import.meta.url), 'utf8');

describe('the finished book actions', () => {
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

    const open = async ({
        operator = false,
        cover = null,
        profile = {
            displayName: 'Elder Example',
            mission: 'Example Mission',
            startDate: '2024-07-01',
            returnDate: '2026-01-15'
        },
        sections = { foreword: null, afterword: null },
        posts = [],
        build = { id: 'book-2', state: 'building', missing: [] },
        checkout = null,
        sale = null,
        book = {},
        order = null,
        visibility = null
    } = {}) => {
        const view = page({ html: 'book.html', path: '/book/elder.example' });
        view.context.setTimeout = () => 1;
        view.context.clearTimeout = () => {};
        const net = fetching(async (url, init) => {
            if (url.includes('/api/profile/')) return { body: profile };
            if (url.endsWith('/sections')) return { body: sections };
            if (url.includes('/posts.json')) return { body: { posts } };
            if (url.endsWith('/cover')) return cover ? { body: cover } : { status: 404 };
            if (init.method === 'POST' && url.endsWith('/api/book/elder.example')) {
                return { status: 202, body: build };
            }
            if (init.method === 'POST' && url.includes('/api/print/')) return { body: order };
            if (init.method === 'PUT' && url.includes('/api/print/')) {
                return {
                    body: {
                        ...visibility,
                        visible: JSON.parse(init.body).visible
                    }
                };
            }
            return {
                body: {
                    id: 'book-1',
                    state: 'ready',
                    builtAt: '2026-09-12T12:00:00.000Z',
                    pages: 24,
                    letters: 3,
                    printing: true,
                    operator,
                    checkout,
                    sale,
                    ...book
                }
            };
        });
        run('book.js', { context: view.context, fetch: net.fetch });
        await settled();
        view.net = net;
        return view;
    };

    test('shows the print file to an operator', async () => {
        const view = await open({ operator: true });

        assert.match(view.el('proof').href, /\/proof\.pdf$/);
        assert.equal(view.el('print').hidden, false);
        assert.match(view.el('print').href, /\/letters\.pdf$/);
    });

    test('does not show the print file to an archive owner', async () => {
        const view = await open();

        assert.match(view.el('proof').href, /\/proof\.pdf$/);
        assert.equal(view.el('print').hidden, true);
    });

    test('shows the mission dates on the cover preview', async () => {
        const view = await open({
            cover: {
                title: 'Elder Example',
                mission: 'Example Mission',
                dates: 'July 1, 2024 \u2013 January 15, 2026',
                cloth: 'navy',
                picture: '',
                cloths: []
            }
        });

        assert.equal(view.text('board-dates'), 'July 1, 2024 \u2013 January 15, 2026');
        assert.equal(view.el('board-dates').hidden, false);
    });

    test('starts a build without prompting when every finishing touch is present', async () => {
        const view = await open({
            cover: {
                title: 'Elder Example',
                mission: 'Example Mission',
                dates: 'July 1, 2024 \u2013 January 15, 2026',
                cloth: 'navy',
                picture: 'p_123456789abc',
                cloths: []
            },
            sections: { foreword: '<p>Welcome.</p>', afterword: '<p>Home.</p>' },
            posts: [
                {
                    photos: [{ id: 'p_123456789abc' }],
                    featuredPhotoIds: ['p_123456789abc']
                }
            ]
        });

        await view.el('make').dispatch('click');
        await settled();

        assert.notEqual(view.el('book-checklist').open, true);
        assert.ok(
            view.net.calls.some(
                (call) => call.method === 'POST' && call.url.endsWith('/api/book/elder.example')
            )
        );
    });

    test('offers missing optional finishing touches before starting the build', async () => {
        const view = await open({
            cover: {
                title: 'Elder Example',
                mission: 'Example Mission',
                dates: '',
                cloth: 'navy',
                picture: '',
                cloths: []
            },
            profile: {
                displayName: 'Elder Example',
                mission: 'Example Mission',
                startDate: '',
                returnDate: ''
            },
            posts: [{ photos: [{ id: 'p_123456789abc' }] }]
        });

        await view.el('make').dispatch('click');
        await settled();

        assert.equal(view.el('book-checklist').open, true);
        assert.equal(view.el('check-name').className.includes('is-complete'), true);
        assert.equal(view.el('check-dates').className.includes('is-complete'), false);
        assert.equal(view.el('check-cover-action').hidden, false);
        assert.equal(view.el('check-featured').hidden, false);
        assert.match(view.el('check-dates-action').href, /\/settings\/elder\.example#startDate$/);
        assert.equal(view.el('book-checklist-anyway').disabled, false);
        assert.equal(
            view.net.calls.some(
                (call) => call.method === 'POST' && call.url.endsWith('/api/book/elder.example')
            ),
            false
        );

        await view.el('book-checklist-anyway').dispatch('click');
        await settled();

        assert.ok(
            view.net.calls.some(
                (call) => call.method === 'POST' && call.url.endsWith('/api/book/elder.example')
            )
        );
    });

    test('requires the missionary name but does not require featured photos when there are no pictures', async () => {
        const missingName = await open({
            cover: {
                title: 'elder.example',
                mission: 'Example Mission',
                dates: 'July 1, 2024 \u2013 January 15, 2026',
                cloth: 'navy',
                picture: 'p_123456789abc',
                cloths: []
            },
            profile: {
                displayName: '',
                mission: 'Example Mission',
                startDate: '2024-07-01',
                returnDate: '2026-01-15'
            },
            sections: { foreword: '<p>Welcome.</p>', afterword: '<p>Home.</p>' }
        });

        await missingName.el('make').dispatch('click');
        await settled();

        assert.equal(missingName.el('book-checklist').open, true);
        assert.equal(missingName.el('book-checklist-anyway').disabled, true);
        assert.equal(missingName.el('book-checklist-required').hidden, false);
        assert.equal(missingName.el('check-featured').hidden, true);
    });

    test('opens a missing book-only section directly from the checklist', async () => {
        const view = await open({
            cover: {
                title: 'Elder Example',
                mission: 'Example Mission',
                dates: 'July 1, 2024 \u2013 January 15, 2026',
                cloth: 'navy',
                picture: '',
                cloths: []
            }
        });

        await view.el('make').dispatch('click');
        await settled();
        await view.el('check-foreword-action').dispatch('click');

        assert.equal(view.el('book-checklist').open, false);
        assert.equal(view.el('book-part-dialog').open, true);
        assert.equal(view.el('book-part-title').textContent, 'Foreword');
        assert.equal(view.el('book-part-editor').getAttribute('contenteditable'), 'true');
    });

    test('shows an active checkout immediately with its expiration', async () => {
        const listedUntil = '2099-04-03T23:54:54.009Z';
        const checkout = {
            active: true,
            visible: true,
            checkoutUrl: 'https://www.peecho.com/checkout/print/en/a-book?token=secret',
            listedUntil
        };
        const view = await open({
            checkout,
            sale: {
                id: 'book-1',
                builtAt: '2026-09-12T12:00:00.000Z',
                pages: 24,
                letters: 3,
                checkout
            }
        });

        assert.equal(view.el('sale').hidden, false);
        assert.equal(view.el('finished').hidden, true);
        assert.match(view.el('buy').href, /peecho\.com\/checkout/);
        assert.equal(view.el('close-checkout').hidden, false);
        assert.equal(view.el('restore-checkout').hidden, true);
        assert.equal(view.el('checkout-expires').getAttribute('data-listed-until'), listedUntil);
        assert.match(view.text('checkout-expires'), /remaining/);
        assert.equal(view.text('make'), 'Make a revised version');
    });

    test('an expired checkout is not presented as an active link', async () => {
        const listedUntil = '2020-04-03T23:54:54.009Z';
        const view = await open({ checkout: { active: false, listedUntil } });

        assert.equal(view.el('sale').hidden, true);
        assert.equal(view.el('checkout-expired').hidden, false);
        assert.equal(view.el('order-controls').hidden, false);
        assert.match(view.text('checkout-expired'), /expired/);
    });

    test('a newly created checkout updates the existing status panel', async () => {
        const listedUntil = '2099-04-03T23:54:54.009Z';
        const view = await open({
            order: {
                checkoutUrl: 'https://www.peecho.com/checkout/print/en/new-book?token=secret',
                listedUntil,
                reused: false
            }
        });

        await view.el('order').dispatch('click');
        await settled();

        assert.equal(view.el('sale').hidden, false);
        assert.equal(view.el('finished').hidden, true);
        assert.equal(view.el('checkout-expires').getAttribute('data-listed-until'), listedUntil);
    });

    test('closes and restores only the archive toolbar entry', async () => {
        const listedUntil = '2099-04-03T23:54:54.009Z';
        const checkoutUrl = 'https://www.peecho.com/checkout/print/en/a-book?token=secret';
        const checkout = { active: true, visible: true, checkoutUrl, listedUntil };
        const view = await open({
            checkout,
            sale: {
                id: 'book-1',
                builtAt: '2026-09-12T12:00:00.000Z',
                pages: 24,
                letters: 3,
                checkout
            },
            visibility: { checkoutUrl, listedUntil }
        });

        await view.el('close-checkout').dispatch('click');
        await settled();

        assert.equal(view.el('close-checkout').hidden, true);
        assert.equal(view.el('restore-checkout').hidden, false);
        assert.match(view.text('checkout-expires'), /hidden from the archive toolbar/);

        await view.el('restore-checkout').dispatch('click');
        await settled();

        assert.equal(view.el('close-checkout').hidden, false);
        assert.equal(view.el('restore-checkout').hidden, true);
        assert.match(view.text('sale-said'), /visible in the archive again/);
    });

    test('keeps the sale proof pinned beside a newer draft', async () => {
        const listedUntil = '2099-04-03T23:54:54.009Z';
        const checkout = {
            active: true,
            visible: true,
            checkoutUrl: 'https://www.peecho.com/checkout/print/en/a-book?token=secret',
            listedUntil
        };
        const view = await open({
            book: {
                id: 'book-2',
                builtAt: '2026-10-05T12:00:00.000Z',
                pages: 30,
                letters: 4
            },
            sale: {
                id: 'book-1',
                builtAt: '2026-09-12T12:00:00.000Z',
                pages: 24,
                letters: 3,
                checkout
            }
        });

        assert.match(view.el('sale-proof').href, /\/book-1\/proof\.pdf$/);
        assert.match(view.el('proof').href, /\/book-2\/proof\.pdf$/);
        assert.equal(view.el('sale').hidden, false);
        assert.equal(view.el('finished').hidden, false);
        assert.match(view.el('sale').getAttribute('class'), /\bentry\b/);
        assert.ok(view.source.indexOf('id="finished"') < view.source.indexOf('id="published-books"'));
        assert.equal(view.text('book-heading'), 'Latest draft');
        assert.equal(view.el('checkout-blocked').hidden, false);
        assert.equal(view.el('order-controls').hidden, false);
        assert.equal(view.text('order'), 'Replace checkout with this draft');
        assert.equal(view.text('make'), 'Make a revised version');
    });

    test('replaces the current checkout only after an explicit confirmation', async () => {
        const listedUntil = '2099-04-03T23:54:54.009Z';
        const checkout = {
            active: true,
            visible: true,
            checkoutUrl: 'https://www.peecho.com/checkout/print/en/old?token=secret',
            listedUntil
        };
        const view = await open({
            book: {
                id: 'book-2',
                builtAt: '2026-10-05T12:00:00.000Z',
                pages: 30,
                letters: 4
            },
            sale: {
                id: 'book-1',
                builtAt: '2026-09-12T12:00:00.000Z',
                pages: 24,
                letters: 3,
                checkout
            },
            order: {
                checkoutUrl: 'https://www.peecho.com/checkout/print/en/new?token=secret',
                listedUntil,
                visible: true,
                reused: false,
                replaced: true
            }
        });

        await view.el('order').dispatch('click');
        await settled();

        assert.match(view.context.asked.question, /Replace the current checkout/);
        assert.match(view.context.asked.detail, /previously shared Peecho link may still work/);
        const posted = view.net.calls.find((call) => call.method === 'POST');
        assert.match(posted.url, /\/book-2\?replace=1$/);
        assert.equal(view.el('finished').hidden, true);
        assert.match(view.el('buy').href, /\/new\?token=secret$/);
        assert.match(view.text('order-said'), /now the version for sale/);
    });

    test('keeps the current checkout when replacement is cancelled', async () => {
        const checkout = {
            active: true,
            visible: true,
            checkoutUrl: 'https://www.peecho.com/checkout/print/en/old?token=secret',
            listedUntil: '2099-04-03T23:54:54.009Z'
        };
        const view = await open({
            book: { id: 'book-2' },
            sale: {
                id: 'book-1',
                builtAt: '2026-09-12T12:00:00.000Z',
                pages: 24,
                letters: 3,
                checkout
            }
        });
        view.context.confirmed = false;

        await view.el('order').dispatch('click');

        assert.equal(view.net.calls.some((call) => call.method === 'POST'), false);
        assert.match(view.el('buy').href, /\/old\?token=secret$/);
    });

    test('keeps the sale proof available while a revised version is building', async () => {
        const checkout = {
            active: true,
            visible: true,
            checkoutUrl: 'https://www.peecho.com/checkout/print/en/a-book?token=secret',
            listedUntil: '2099-04-03T23:54:54.009Z'
        };
        const view = await open({
            book: { id: 'book-2', state: 'building' },
            sale: {
                id: 'book-1',
                builtAt: '2026-09-12T12:00:00.000Z',
                pages: 24,
                letters: 3,
                checkout
            }
        });

        assert.equal(view.el('sale').hidden, false);
        assert.match(view.el('sale-proof').href, /\/book-1\/proof\.pdf$/);
        assert.equal(view.el('finished').hidden, true);
        assert.equal(view.el('make').disabled, true);
    });
});
