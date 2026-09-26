// The short-lived QR invitation shared by the People page and archive menu.
//
// This only decides when to display and refresh the code. The members API
// remains the authority: it requires an owner for every create, refresh, and
// close request.

/* global qrcode */

(function () {
    'use strict';

    function mount(slug, triggerId = 'qr-open') {
        const trigger = document.getElementById(triggerId);
        const dialog = document.getElementById('qr-dialog');
        const image = document.getElementById('qr-image');
        const status = document.getElementById('qr-status');
        if (!slug || !trigger || !dialog || !image || !status) return;

        let session = '';
        let timer = null;
        let open = false;

        const api = (path, init) =>
            fetch(`/api/members/${encodeURIComponent(slug)}${path}`, {
                cache: 'no-store',
                ...init
            });

        function draw(url) {
            const code = qrcode(0, 'M');
            code.addData(url);
            code.make();
            image.setAttribute('src', code.createDataURL(6, 4));
        }

        async function closeSession() {
            open = false;
            if (timer) clearInterval(timer);
            timer = null;

            const id = session;
            session = '';
            if (!id) return;

            try {
                await api(`/qr/${encodeURIComponent(id)}`, {
                    method: 'DELETE',
                    keepalive: true
                });
            } catch {
                // The server expires an abandoned session after ninety seconds.
            }
        }

        async function refresh() {
            const path = session ? `/qr/${encodeURIComponent(session)}` : '/qr';
            const response = await api(path, { method: 'POST' });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error ?? 'could not create the code');

            if (!open) {
                session = body.id;
                await closeSession();
                return;
            }

            session = body.id;
            draw(body.url);
            status.textContent =
                'The code refreshes every 30 seconds. Closing this window ends the invitation.';
        }

        async function show() {
            open = true;
            image.removeAttribute('src');
            status.textContent = 'Creating a temporary code\u2026';

            const menu = trigger.closest?.('details');
            if (menu) menu.open = false;
            dialog.showModal();

            try {
                await refresh();
                timer = setInterval(async () => {
                    try {
                        await refresh();
                    } catch {
                        image.removeAttribute('src');
                        status.textContent =
                            'The code could not be refreshed. Close this window and try again.';
                    }
                }, 25000);
            } catch {
                status.textContent =
                    'The code could not be created. Close this window and try again.';
            }
        }

        trigger.addEventListener('click', show);
        dialog.addEventListener('close', closeSession);
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });
    }

    window.QuickJoin = { mount };
})();
