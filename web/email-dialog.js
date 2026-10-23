// Email scheduling without taking somebody away from the archive.

/* global EmailSchedule */

window.EmailDialog = (() => {
    'use strict';

    const JOINED_KEY = 'email-notification-prompt-after-join';
    const SHOWN_KEY = 'email-notification-prompt-shown';

    const byId = (id) => document.getElementById(id);

    function mount(slug) {
        const dialog = byId('email-dialog');
        const link = byId('email-settings');
        if (!dialog || !link) return;

        let mode = 'manual';
        let saved = false;
        const schedule = EmailSchedule.create({
            elements: {
                form: byId('email-dialog-form'),
                weekly: byId('email-dialog-weekly'),
                monthly: byId('email-dialog-monthly'),
                off: byId('email-dialog-off'),
                weekRow: byId('email-dialog-week-row'),
                weekdayRow: byId('email-dialog-weekday-row'),
                week: byId('email-dialog-week'),
                weekday: byId('email-dialog-weekday'),
                preview: byId('email-dialog-preview'),
                submit: byId('email-dialog-submit'),
                status: byId('email-dialog-status')
            },
            onUnauthorized: () => {
                window.location.href =
                    `/login.html?post_login_redirect_uri=${encodeURIComponent(window.location.pathname)}`;
            },
            onSaved: () => {
                saved = true;
                dialog.close();
            }
        });

        const open = (preferences, automatic) => {
            if (preferences.suppressed) {
                if (!automatic) window.location.href = '/email';
                return;
            }

            mode = automatic ? 'automatic' : 'manual';
            saved = false;
            byId('email-dialog-title').textContent = automatic
                ? 'Don\u2019t miss a letter'
                : 'Email notifications';
            byId('email-dialog-copy').textContent = automatic
                ? 'We can let you know when new letters arrive. Choose a weekly or monthly schedule that works for you. No new letters means no email.'
                : 'Choose when we should check for new letters. We will send an email only when something new has arrived.';
            byId('email-dialog-dismiss').textContent = automatic ? 'Not now' : 'Close';
            byId('email-dialog-status').textContent = '';
            schedule.set(preferences);
            dialog.showModal();
            sessionStorage.setItem(SHOWN_KEY, '1');
        };

        link.addEventListener('click', async (event) => {
            if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            const menu = byId('menu');
            if (menu) menu.open = false;

            const result = await EmailSchedule.call('GET');
            if (result.status === 401) {
                window.location.href = link.href;
                return;
            }
            if (!result.ok) {
                window.location.href = link.href;
                return;
            }
            open(result.body, false);
        });

        byId('email-dialog-dismiss').addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => {
            if (mode === 'automatic' && !saved) {
                void EmailSchedule.call('PUT', null, '/api/preferences/prompt');
            }
            mode = 'manual';
        });

        void (async () => {
            const result = await EmailSchedule.call('POST', null, '/api/preferences/prompt');
            if (!result.ok) return;

            const joined = sessionStorage.getItem(JOINED_KEY) === slug;
            if (
                result.body.digestFrequency !== 'off' ||
                result.body.suppressed ||
                sessionStorage.getItem(SHOWN_KEY) ||
                (!joined && !result.body.promptDue)
            ) {
                if (joined && (result.body.digestFrequency !== 'off' || result.body.suppressed)) {
                    sessionStorage.removeItem(JOINED_KEY);
                }
                return;
            }

            window.setTimeout(() => {
                if (!dialog.open && !sessionStorage.getItem(SHOWN_KEY)) {
                    if (joined) sessionStorage.removeItem(JOINED_KEY);
                    open(result.body, true);
                }
            }, 5000);
        })();
    }

    return { mount };
})();
