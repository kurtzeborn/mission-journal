import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { describe, test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../web/site.html', import.meta.url), 'utf8');
const scheduleScript = readFileSync(new URL('../../web/email-schedule.js', import.meta.url), 'utf8');
const dialogScript = readFileSync(new URL('../../web/email-dialog.js', import.meta.url), 'utf8');

async function archive({ prompt = {}, joined = false } = {}) {
    const dom = new JSDOM(html, {
        runScripts: 'outside-only',
        url: 'https://pdayletters.com/elder.example/'
    });
    const { window } = dom;
    const calls = [];
    const dialog = window.document.getElementById('email-dialog');
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => {
        dialog.open = false;
        dialog.dispatchEvent(new window.Event('close'));
    };
    window.setTimeout = (callback) => {
        callback();
        return 1;
    };
    if (joined) {
        window.sessionStorage.setItem('email-notification-prompt-after-join', 'elder.example');
    }
    window.fetch = async (url, init = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body });
        const body =
            url === '/api/preferences/prompt' && init.method === 'POST'
                ? {
                      digestFrequency: 'off',
                      digestWeekday: 1,
                      digestWeek: 1,
                      suppressed: false,
                      promptDue: false,
                      ...prompt
                  }
                : {
                      email: 'grandma@example.com',
                      digestFrequency: 'off',
                      digestWeekday: 1,
                      digestWeek: 1,
                      suppressed: false,
                      ...prompt
                  };
        return { ok: true, status: 200, json: async () => body };
    };

    runInContext(scheduleScript, dom.getInternalVMContext(), { filename: 'email-schedule.js' });
    runInContext(dialogScript, dom.getInternalVMContext(), { filename: 'email-dialog.js' });
    window.EmailDialog.mount('elder.example');
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    return { window, dialog, calls };
}

describe('email notifications on an archive', () => {
    test('a new reader is offered a weekly schedule without leaving the archive', async () => {
        const { window, dialog } = await archive({ joined: true });

        assert.equal(dialog.open, true);
        assert.equal(window.document.getElementById('email-dialog-title').textContent, 'Don\u2019t miss a letter');
        assert.equal(window.document.getElementById('email-dialog-weekly').checked, true);
        assert.equal(window.location.pathname, '/elder.example/');
        assert.equal(
            window.sessionStorage.getItem('email-notification-prompt-after-join'),
            null
        );
    });

    test('the fifth-visit response opens the reminder only while summaries are off', async () => {
        assert.equal((await archive({ prompt: { promptDue: true } })).dialog.open, true);
        assert.equal(
            (await archive({ prompt: { promptDue: true, digestFrequency: 'weekly' } })).dialog.open,
            false
        );
    });

    test('the account menu opens the same controls and keeps the standalone fallback link', async () => {
        const { window, dialog } = await archive();
        const link = window.document.getElementById('email-settings');
        link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        for (let i = 0; i < 8; i += 1) await Promise.resolve();

        assert.equal(dialog.open, true);
        assert.equal(window.document.getElementById('email-dialog-title').textContent, 'Email notifications');
        assert.equal(window.document.getElementById('email-dialog-off').checked, true);
        assert.equal(link.getAttribute('href'), '/email');
    });

    test('dismissing an automatic reminder resets the visit interval', async () => {
        const { window, calls } = await archive({ prompt: { promptDue: true } });
        window.document.getElementById('email-dialog-dismiss').click();
        for (let i = 0; i < 8; i += 1) await Promise.resolve();

        assert.ok(calls.some((call) => call.url === '/api/preferences/prompt' && call.method === 'PUT'));
    });
});
