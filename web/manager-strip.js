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

    function metric(label, value, title, modifier = '') {
        const item = document.createElement('span');
        item.className = `manager-strip__metric${modifier ? ` manager-strip__metric--${modifier}` : ''}`;
        item.textContent = `${label}:${value}`;
        item.title = title;
        return item;
    }

    function elapsed(milliseconds) {
        const value = Math.max(0, Number(milliseconds) || 0);
        return value < 1000
            ? `${Math.round(value)}ms`
            : `${(value / 1000).toFixed(1)}s`;
    }

    function observeLargestPaint(stats) {
        if (typeof window.PerformanceObserver !== 'function') return;

        const item = metric('LCP', '\u2014', 'Largest Contentful Paint: when the main visible content appeared');
        stats.append(item);

        try {
            const observer = new window.PerformanceObserver((list) => {
                const entries = list.getEntries();
                const latest = entries[entries.length - 1];
                if (latest) item.textContent = `LCP:${elapsed(latest.startTime)}`;
            });
            observer.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
            item.remove();
        }
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

        const pending = Number(counts.pending ?? 0);
        const deleted = Number(counts.deleted ?? 0);
        const stats = document.createElement('span');
        stats.className = 'manager-strip__stats';
        stats.append(
            metric('A', Number(counts.archives ?? 0), 'Active archives'),
            metric('P', pending, 'Pending archives', pending ? 'pending' : ''),
            metric('D', deleted, 'Archives pending deletion', deleted ? 'deleted' : ''),
            metric('U', Number(counts.users ?? 0), 'Users'),
            metric('MAU', Number(counts.monthlyActive ?? 0), 'Monthly active users')
        );
        observeLargestPaint(stats);

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
