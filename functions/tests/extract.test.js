// Runs the extractor over the scrubbed public corpus and checks it against
// the assertions recorded alongside each capture. The sidecars were written
// by reading the messages, not by running this code, so agreement is evidence
// rather than a tautology.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOriginal } from '../src/lib/extract.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const names = (await readdir(fixtures)).filter((f) => f.endsWith('.eml')).sort();

assert.ok(names.length > 0, 'no fixtures found');

for (const name of names) {
    test(name, async () => {
        const raw = await readFile(join(fixtures, name));
        const expected = JSON.parse(
            await readFile(join(fixtures, name.replace(/\.eml$/, '.expected.json')), 'utf8')
        );
        const got = await extractOriginal(raw);

        assert.equal(got.source, expected.extractionSource, 'extractionSource');
        // A direct send has no forwarder. Expressing that as an explicit null
        // rather than skipping the check keeps the assertion honest.
        assert.equal(got.forwarder, expected.forwarder ?? null, 'forwarder');

        // Worth asserting even when empty: the outer subject of an attached
        // forward from Gmail web is the empty string, and the Fwd:/Fw:/FW:
        // prefixes differ per client.
        if ('outerSubject' in expected) {
            assert.equal(got.outerSubject, expected.outerSubject, 'outerSubject');
        }

        if (expected.embeddedPartType) {
            assert.equal(got.embeddedPartType, expected.embeddedPartType, 'embeddedPartType');
        }

        assert.equal(got.original.from, expected.original.from, 'original.from');
        assert.equal(got.original.subject, expected.original.subject, 'original.subject');

        // The sidecars record the original offset; the extractor normalises to
        // UTC. Comparing instants rather than text keeps both honest.
        if (expected.original.date) {
            assert.equal(
                new Date(got.original.date).getTime(),
                new Date(expected.original.date).getTime(),
                'original.date'
            );
        }

        if (expected.extractionSource === 'inline') {
            assert.equal(got.original.dateText, expected.original.dateText, 'original.dateText');
            assert.equal(
                got.original.datePrecision,
                expected.original.datePrecision,
                'original.datePrecision'
            );
        }

        if (expected.original.messageId) {
            assert.equal(got.original.messageId, expected.original.messageId, 'messageId');
        }

        assert.deepEqual(
            got.attachments.map((a) => a.filename).sort(),
            [...expected.attachmentNames].sort(),
            'attachmentNames'
        );
        assert.equal(got.inlineImages.length, expected.inlineImageCount, 'inlineImageCount');
        assert.deepEqual(got.inlineCids.sort(), [...expected.inlineCids].sort(), 'inlineCids');
    });
}
