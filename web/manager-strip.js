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

    function stylesheet(href) {
        if (document.querySelector(`link[href="${href}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.append(link);
    }

    function iconLink({ href, label, icon, external = false }) {
        const link = document.createElement('a');
        link.className = 'manager-strip__link';
        link.href = href;
        link.setAttribute('aria-label', label);
        link.title = label;
        if (external) {
            link.target = '_blank';
            link.rel = 'noopener';
        }

        const glyph = document.createElement('i');
        glyph.className = `fa-solid ${icon}`;
        glyph.setAttribute('aria-hidden', 'true');
        link.append(glyph);
        return link;
    }

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

        stylesheet('/vendor/fontawesome/css/fontawesome.min.css');
        stylesheet('/vendor/fontawesome/css/solid.min.css');

        const manage = iconLink({
            href: '/manage',
            label: 'Open service tooling',
            icon: 'fa-gear'
        });

        const stats = document.createElement('span');
        stats.textContent =
            `A:${Number(counts.archives ?? 0)} ` +
            `P:${Number(counts.pending ?? 0)} ` +
            `D:${Number(counts.deleted ?? 0)} ` +
            `U:${Number(counts.users ?? 0)} ` +
            `MAU:${Number(counts.monthlyActive ?? 0)}`;

        const sha = String(window.PDAY_DEPLOY_SHA ?? '');
        const version = /^[0-9a-f]{40}$/i.test(sha)
            ? iconLink({
                  href: `https://github.com/kurtzeborn/mission-journal/commit/${sha}`,
                  label: `View deployed commit ${sha.slice(0, 7)} on GitHub`,
                  icon: 'fa-code-branch',
                  external: true
              })
            : null;

        strip.append(manage, stats);
        if (version) strip.append(version);
        document.body.prepend(strip);
    }

    load();
})();
