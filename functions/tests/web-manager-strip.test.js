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

async function page({
    desktop = true,
    status = 200,
    body = {},
    sha = '78318d36c72399dd762ba7c8562710a332eb8737',
    largestPaint = 842,
    fetchImpl
} = {}) {
    const dom = new JSDOM('<!doctype html><html><body><main>Page</main></body></html>', {
        runScripts: 'outside-only',
        url: 'https://pdayletters.com/about'
    });
    const { window } = dom;
    let calls = 0;

    window.matchMedia = () => ({ matches: desktop });
    window.PDAY_DEPLOY_SHA = sha;
    if (largestPaint !== null) {
        window.PerformanceObserver = class {
            constructor(callback) {
                this.callback = callback;
            }

            observe(options) {
                this.options = options;
                this.callback({ getEntries: () => [{ startTime: largestPaint }] });
            }
        };
    }
    window.fetch = fetchImpl ?? (async () => {
        calls += 1;
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    });

    runInContext(script, dom.getInternalVMContext(), { filename: 'manager-strip.js' });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    return { window, calls };
}

describe('the manager debug strip', () => {
    test('spaces the counts and includes client-perceived load time after the manager API answers', async () => {
        const { window } = await page({
            body: { archives: 4, pending: 1, deleted: 0, users: 22, monthlyActive: 16 }
        });

        const strip = window.document.querySelector('.manager-strip');
        const stats = strip.querySelector('.manager-strip__stats');
        assert.deepEqual(
            [...stats.children].map((item) => item.textContent),
            ['A:4', 'P:1', 'D:0', 'U:22', 'MAU:16', 'LCP:842ms']
        );
        assert.equal(stats.children[5].getAttribute('title'), 'Largest Contentful Paint: when the main visible content appeared');
        const links = strip.querySelectorAll('a');
        assert.equal(links[0].getAttribute('href'), '/manage');
        assert.equal(links[0].querySelector('i').className, 'fa-solid fa-gear');
        assert.equal(
            links[1].getAttribute('href'),
            'https://github.com/kurtzeborn/mission-journal/commit/78318d36c72399dd762ba7c8562710a332eb8737'
        );
        assert.equal(links[1].querySelector('i').className, 'fa-solid fa-code-branch');
        assert.equal(links[1].getAttribute('target'), '_blank');
        assert.equal(window.document.body.firstElementChild, strip);
        assert.deepEqual(
            [...window.document.head.querySelectorAll('link')].map((link) => link.getAttribute('href')),
            [
                '/vendor/fontawesome/css/fontawesome.min.css',
                '/vendor/fontawesome/css/solid.min.css'
            ]
        );
    });

    test('colors pending yellow and pending deletion red only when action is needed', async () => {
        const active = await page({
            body: { archives: 4, pending: 1, deleted: 2, users: 22, monthlyActive: 16 }
        });
        const activeMetrics = active.window.document.querySelectorAll('.manager-strip__metric');
        assert.match(activeMetrics[1].className, /manager-strip__metric--pending/);
        assert.match(activeMetrics[2].className, /manager-strip__metric--deleted/);

        const clear = await page({
            body: { archives: 4, pending: 0, deleted: 0, users: 22, monthlyActive: 16 }
        });
        const clearMetrics = clear.window.document.querySelectorAll('.manager-strip__metric');
        assert.doesNotMatch(clearMetrics[1].className, /manager-strip__metric--pending/);
        assert.doesNotMatch(clearMetrics[2].className, /manager-strip__metric--deleted/);
    });

    test('omits load timing when the browser cannot observe largest paint', async () => {
        const { window } = await page({
            largestPaint: null,
            body: { archives: 4, pending: 0, deleted: 0, users: 22, monthlyActive: 16 }
        });

        assert.equal(window.document.querySelector('.manager-strip__stats').children.length, 5);
    });

    test('omits the commit link when a local build has no deployed SHA', async () => {
        const { window } = await page({
            sha: '',
            body: { archives: 4, pending: 1, deleted: 0, users: 22, monthlyActive: 16 }
        });

        assert.equal(window.document.querySelectorAll('.manager-strip a').length, 1);
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
