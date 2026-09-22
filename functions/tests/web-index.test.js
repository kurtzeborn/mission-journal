import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');

describe('the public landing page', () => {
    test('opens with the short promise and two direct choices', () => {
        assert.match(source, /Keep every missionary letter in one private place\./);
        assert.match(
            source,
            /Add one address, or forward one letter\. Photos stay with the letters\. Nothing is public\./
        );
        assert.match(source, /href="\/start">Get Started<\/a>/);
        assert.match(source, /href="#reading-an-archive">I was invited<\/a>/);
        assert.doesNotMatch(source, /Choose where to start/);
    });

    test('summarizes the archive before defining the name', () => {
        for (const feature of [
            'Private',
            'Searchable',
            'Photos saved',
            'Optional hardcover book'
        ]) {
            assert.match(source, new RegExp(`<strong>${feature}</strong>`));
        }

        assert.ok(
            source.indexOf('id="how-it-works"') < source.indexOf('class="landing-features"')
        );
        assert.ok(source.indexOf('<h2>Cost</h2>') < source.indexOf('id="pday"'));
        assert.match(source, /Missionary archives are free to set up and use\./);
        assert.doesNotMatch(source, /These missionary archives are free/);
    });
});
