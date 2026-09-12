import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    bookSectionsName,
    changeBookSection,
    readBookSections,
    sanitizeBookSection
} from '../src/lib/booksections.js';
import { memoryStore } from './memory-store.js';

const SLUG = 'elder.example';
const quiet = { info() {} };

describe('book-only sections', () => {
    test('starts with exactly the two optional sections absent', async () => {
        const { sections } = await readBookSections({ store: memoryStore(), slug: SLUG });
        assert.deepEqual(sections, { foreword: null, afterword: null });
    });

    test('keeps rich text but removes scripts, handlers, and every photograph', () => {
        const result = sanitizeBookSection(
            '<p onclick="steal()">Hello <strong>family</strong>.' +
                '<img src="/api/photo/elder.example/p1/large.webp" onerror="steal()"></p>' +
                '<script>steal()</script>'
        );

        assert.match(result.html, /<strong>family<\/strong>/);
        assert.doesNotMatch(result.html, /img|script|onclick|onerror|steal/i);
    });

    test('saves and deletes either section without disturbing the other', async () => {
        const store = memoryStore();
        await changeBookSection({
            store,
            slug: SLUG,
            section: 'foreword',
            bodyHtml: '<p>From Mum.</p>',
            log: quiet
        });
        await changeBookSection({
            store,
            slug: SLUG,
            section: 'afterword',
            bodyHtml: '<p>Home again.</p>',
            log: quiet
        });
        const deleted = await changeBookSection({
            store,
            slug: SLUG,
            section: 'foreword',
            remove: true,
            log: quiet
        });

        assert.deepEqual(deleted.sections, {
            foreword: null,
            afterword: '<p>Home again.</p>'
        });
    });

    test('re-reads after a concurrent write and preserves what won the race', async () => {
        const store = memoryStore();
        const write = store.writeBlob.bind(store);
        let raced = false;
        store.writeBlob = async (container, name, bytes, options) => {
            if (!raced && name === bookSectionsName(SLUG)) {
                raced = true;
                await write(
                    'config',
                    name,
                    Buffer.from(JSON.stringify({ foreword: null, afterword: '<p>The other owner.</p>' }))
                );
                const error = new Error('condition not met');
                error.statusCode = 412;
                throw error;
            }
            return write(container, name, bytes, options);
        };

        const saved = await changeBookSection({
            store,
            slug: SLUG,
            section: 'foreword',
            bodyHtml: '<p>My words.</p>',
            log: quiet
        });

        assert.deepEqual(saved.sections, {
            foreword: '<p>My words.</p>',
            afterword: '<p>The other owner.</p>'
        });
    });

    test('refuses any section other than Foreword and Afterword', async () => {
        const result = await changeBookSection({
            store: memoryStore(),
            slug: SLUG,
            section: 'preface',
            bodyHtml: '<p>No.</p>'
        });
        assert.equal(result.error, 'unknown book section');
    });
});
