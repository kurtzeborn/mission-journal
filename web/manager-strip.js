// A tiny operator-only readout above every desktop page.
//
// There is deliberately no strip in the HTML. The browser creates it only
// after the manager-only API has admitted the signed-in visitor, so an
// anonymous visitor or ordinary archive owner receives neither the data nor a
// hidden management control. The endpoint makes the authorization decision;
// this script only decides whether there is room to draw the answer.

(() => {
    'use strict';

    if (!window.matchMedia('(min-width: 64rem)').matches) return;

    async function load() {
        let response;
        try {
            response = await fetch('/api/manage/summary', { cache: 'no-store' });
        } catch {
            return;
        }

        if (!response.ok) return;

        const counts = await response.json();
        const strip = document.createElement('aside');
        strip.className = 'manager-strip';
        strip.setAttribute('aria-label', 'Service status');

        const manage = document.createElement('a');
        manage.className = 'manager-strip__link';
        manage.href = '/manage';
        manage.setAttribute('aria-label', 'Open service tooling');
        manage.title = 'Open service tooling';
        manage.textContent = '\u2699';

        const stats = document.createElement('span');
        stats.textContent =
            `A:${Number(counts.archives ?? 0)} ` +
            `P:${Number(counts.pending ?? 0)} ` +
            `D:${Number(counts.deleted ?? 0)} ` +
            `U:${Number(counts.users ?? 0)} ` +
            `MAU:${Number(counts.monthlyActive ?? 0)}`;

        strip.append(manage, stats);
        document.body.prepend(strip);
    }

    load();
})();
