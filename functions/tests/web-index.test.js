import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');

describe('the public landing page', () => {
    test('offers direct entry paths and public navigation', () => {
        assert.match(source, /href="\/start"/);
        assert.match(source, /href="#reading-an-archive"/);
        assert.match(source, /class="masthead__links"[\s\S]*href="\/start"/);
        assert.match(source, /class="masthead__links"[\s\S]*href="\/faq"/);
        assert.match(source, /class="masthead__links"[\s\S]*href="\/resources"/);
        assert.match(
            source,
            /class="masthead__link" id="signed-out"[^>]*>/
        );
        assert.doesNotMatch(source, /id="signed-out"[^>]*class="button/);
    });

    test('keeps the overview and supporting links in the intended structure', () => {
        assert.ok(
            source.indexOf('id="how-it-works"') < source.indexOf('class="landing-features"')
        );
        assert.match(
            source,
            /href="\/faq#forward-did-nothing"/
        );
        assert.match(
            source,
            /<span class="address">post@pdayletters\.com<\/span>/
        );
        assert.doesNotMatch(source, /landing-benefits/);
        assert.match(source, /id="reading-an-archive"/);
        assert.match(source, /href="\/about"/);
        assert.match(source, /href="\/resources"/);
        const footer = source.slice(source.indexOf('<p class="note">'));
        assert.doesNotMatch(footer, /href="\/start"/);
        assert.doesNotMatch(footer, /href="\/faq"/);
    });
});
