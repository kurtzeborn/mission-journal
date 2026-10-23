// Shared weekly/monthly email schedule controls used by the standalone
// settings page and the archive dialog.

window.EmailSchedule = (() => {
    'use strict';

    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const WEEKS = ['', 'first', 'second', 'third', 'fourth'];

    async function call(method, payload, path = '/api/preferences') {
        try {
            const response = await fetch(path, {
                method,
                headers: payload ? { 'Content-Type': 'application/json' } : {},
                body: payload ? JSON.stringify(payload) : undefined
            });
            return {
                ok: response.ok,
                status: response.status,
                body: await response.json().catch(() => ({}))
            };
        } catch {
            return { ok: false, status: 0, body: {} };
        }
    }

    function create({ elements, onUnauthorized = () => {}, onSaved = () => {} }) {
        const selectedFrequency = () => {
            if (elements.weekly.checked) return 'weekly';
            if (elements.monthly.checked) return 'monthly';
            return 'off';
        };

        const showSchedule = () => {
            const frequency = selectedFrequency();
            elements.weekRow.hidden = frequency !== 'monthly';
            elements.weekdayRow.hidden = frequency === 'off';

            if (frequency === 'off') {
                elements.preview.textContent = 'We won\u2019t send email summaries.';
                return;
            }

            const weekday = WEEKDAYS[Number(elements.weekday.value)] ?? 'Monday';
            const when =
                frequency === 'monthly'
                    ? `on the ${WEEKS[Number(elements.week.value)] ?? 'first'} ${weekday} of each month`
                    : `every ${weekday}`;
            elements.preview.textContent =
                `We\u2019ll check ${when}. If no new letters have arrived, we won\u2019t send anything.`;
        };

        const set = (values) => {
            const frequency = values.digestFrequency ?? 'off';
            elements.weekly.checked = frequency === 'weekly';
            elements.monthly.checked = frequency === 'monthly';
            elements.off.checked = frequency === 'off';
            elements.weekday.value = String(values.digestWeekday ?? 1);
            elements.week.value = String(values.digestWeek ?? 1);
            showSchedule();
        };

        const save = async (event) => {
            event?.preventDefault();
            elements.submit.disabled = true;

            const result = await call('PUT', {
                digestFrequency: selectedFrequency(),
                digestWeekday: Number(elements.weekday.value),
                digestWeek: Number(elements.week.value)
            });

            if (result.status === 401) {
                onUnauthorized();
                return result;
            }

            elements.submit.disabled = false;
            elements.status.textContent = result.ok
                ? 'Saved.'
                : 'That did not save. Please try again in a moment.';
            if (result.ok) onSaved(result);
            return result;
        };

        elements.form.addEventListener('submit', save);
        for (const element of [
            elements.weekly,
            elements.monthly,
            elements.off,
            elements.weekday,
            elements.week
        ]) {
            element.addEventListener('change', showSchedule);
        }

        return { set, save, selectedFrequency };
    }

    return { call, create };
})();
