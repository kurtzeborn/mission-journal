// The manager strip is absent by default and created only after the protected
// summary endpoint admits the current account. These tests run the real script
// so an authorization failure cannot accidentally leave hidden operator data
// or controls in the page.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { describe, test } from 'node:test';
import { JSDOM } from 'jsdom';

const script = readFileSync(new URL('../../web/manager-strip.js', import.meta.url), 'utf8');

async function page({ desktop = true, status = 200, body = {}, fetchImpl } = {}) {
    const dom = new JSDOM('<!doctype html><html><body><main>Page</main></body></html>', {
        runScripts: 'outside-only',
        url: 'https://pdayletters.com/about'
    });
    const { window } = dom;
    let calls = 0;

    window.matchMedia = () => ({ matches: desktop });
    window.fetch = fetchImpl ?? (async () => {
        calls += 1;
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    });

    runInContext(script, dom.getInternalVMContext(), { filename: 'manager-strip.js' });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    return { window, calls };
}

describe('the manager debug strip', () => {
    test('shows only the five requested counts after the manager API answers', async () => {
        const { window } = await page({
            body: { archives: 4, pending: 1, deleted: 0, users: 22, monthlyActive: 16 }
        });

        const strip = window.document.querySelector('.manager-strip');
        assert.equal(strip.textContent, '\u2699A:4 P:1 D:0 U:22 MAU:16');
        assert.equal(strip.querySelector('a').getAttribute('href'), '/manage');
        assert.equal(window.document.body.firstElementChild, strip);
    });

    test('creates no strip for a signed-out visitor or an ordinary user', async () => {
        for (const status of [401, 404]) {
            const { window } = await page({ status });
            assert.equal(window.document.querySelector('.manager-strip'), null);
            assert.equal(window.document.body.textContent, 'Page');
        }
    });

    test('does not request manager data on a phone', async () => {
        const { window, calls } = await page({
            desktop: false,
            body: { archives: 4, pending: 1, deleted: 0, users: 22, monthlyActive: 16 }
        });

        assert.equal(calls, 0);
        assert.equal(window.document.querySelector('.manager-strip'), null);
    });
});
