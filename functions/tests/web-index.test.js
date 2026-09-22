import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const source = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
const startSource = readFileSync(new URL('../../web/start.html', import.meta.url), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');

describe('the public landing page', () => {
    test('opens with the short promise and two direct choices', () => {
        assert.match(source, /Keep every missionary letter in one private place\./);
        assert.match(
            source,
            /Add one address, or forward one letter\. Photos stay with the letters\. The archive is private\./
        );
        assert.match(source, /href="\/start">Get started<\/a>/);
        assert.match(source, /href="#reading-an-archive">I was invited<\/a>/);
        assert.doesNotMatch(source, /Choose where to start/);
        assert.match(source, /class="masthead__links"[\s\S]*href="\/start">Start<\/a>/);
        assert.match(source, /class="masthead__links"[\s\S]*href="\/faq">Questions<\/a>/);
        assert.match(
            source,
            /class="masthead__link" id="signed-out"[^>]*>Sign in<\/a>/
        );
        assert.doesNotMatch(source, /id="signed-out"[^>]*class="button/);
    });

    test('summarizes the archive before defining the name', () => {
        for (const feature of [
            'Private',
            'Searchable',
            'Photos saved',
            'Hardcover book',
            'Calm and simple'
        ]) {
            assert.match(source, new RegExp(`<strong>${feature}</strong>`));
        }

        assert.match(source, /Only invited family can see it\./);
        assert.match(source, /Kept with the letter they arrived with\./);
        assert.match(source, /Print the archive when you want a book\./);
        assert.ok(
            source.indexOf('id="how-it-works"') < source.indexOf('class="landing-features"')
        );
        assert.match(
            source,
            /These steps work before they leave, or after they&rsquo;re already in the field\./
        );
        assert.match(
            source,
            /<strong>Forward one letter as an <a href="\/faq#forward-did-nothing">attachment<\/a><\/strong>/
        );
        assert.match(
            source,
            /<strong>Ask the missionary to include<\/strong>\s*<span class="address">post@pdayletters\.com<\/span>/
        );
        assert.match(source, /From then on, letters and photos are filed automatically\./);
        assert.match(
            source,
            /<br>\s*<span class="note note--small">Older letters can be forwarded later\. Owners can add pictures from a phone or Google Photos\./
        );
        assert.match(source, /No ads\. No clutter\. Just letters\./);
        assert.doesNotMatch(source, /landing-benefits/);
        assert.ok(source.indexOf('<h2>Cost</h2>') < source.indexOf('id="pday"'));
        assert.match(source, /<h2 id="reading-an-archive">If you were invited<\/h2>/);
        assert.match(source, /We can email you when new letters arrive\./);
        assert.doesNotMatch(source, /After your missionary returns home/);
        assert.match(source, /The archive is free\. No subscription\./);
        assert.match(source, /href="\/about">Who made this\?<\/a>/);
        const footer = source.slice(source.indexOf('<p class="note">'));
        assert.doesNotMatch(footer, /href="\/start"/);
        assert.doesNotMatch(footer, /href="\/faq"/);
    });

    test('spells the missionary setup instructions correctly', () => {
        assert.match(startSource, /their weekly letter/);
        assert.doesNotMatch(startSource, /\bthier\b/i);
    });
});
