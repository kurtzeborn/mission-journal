// Runs the extractor over the scrubbed public corpus and checks it against
// the assertions recorded alongside each capture. The sidecars were written
// by reading the messages, not by running this code, so agreement is evidence
// rather than a tautology.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOriginal, parseAddress } from '../src/lib/extract.js';

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

// postal-mime normalises line endings as it decodes, which silently cost a
// 200KB original some 2,700 bytes. Nothing downstream noticed, because relaxed
// canonicalization normalises line endings before hashing, so every signature
// verdict stayed the same while the stored bytes were no longer the sent ones.
test('an extracted original carries CRLF line endings', async () => {
    let checked = 0;

    for (const name of names) {
        const got = await extractOriginal(await readFile(join(fixtures, name)));
        if (got.source !== 'rfc822') continue;

        checked += 1;
        const text = Buffer.from(got.embeddedBytes).toString('latin1');
        assert.equal(text.match(/(?<!\r)\n/g), null, `${name} has a bare LF`);
    }

    assert.ok(checked > 0, 'no attached fixtures to check');
});

describe('reading the sender out of a quoted From: line', () => {
    test('takes the address a client wrote in angle brackets', () => {
        assert.equal(
            parseAddress('Isaac Backman <isaac.backman@missionary.org>'),
            'isaac.backman@missionary.org'
        );
        assert.equal(parseAddress('<isaac.backman@missionary.org>'), 'isaac.backman@missionary.org');
        assert.equal(parseAddress('isaac.backman@missionary.org'), 'isaac.backman@missionary.org');
    });

    test('prefers the brackets when the display name contains an at sign', () => {
        assert.equal(
            parseAddress('"the isaac@home account" <isaac.backman@missionary.org>'),
            'isaac.backman@missionary.org'
        );
    });

    // Outlook flattens its HTML forward header into the plain-text part as the
    // address followed by a mailto: link to the same address. Both halves of
    // this cost a real letter: the scheme became part of the local part, and
    // the wrapped line -- which is how it actually arrived, the closing
    // bracket having landed on the next line -- matched nothing at all, so the
    // whole doubled string was taken for an address.
    test('unpicks the address Outlook writes twice with a mailto link', () => {
        assert.equal(
            parseAddress('isaac.backman@missionary.org<mailto:isaac.backman@missionary.org>'),
            'isaac.backman@missionary.org'
        );
        assert.equal(
            parseAddress('isaac.backman@missionary.org<mailto:isaac.backman@missionary.org'),
            'isaac.backman@missionary.org'
        );
    });

    test('has nothing to report when there is no address', () => {
        assert.equal(parseAddress('Isaac Backman'), null);
        assert.equal(parseAddress(''), null);
        assert.equal(parseAddress(null), null);
    });
});

