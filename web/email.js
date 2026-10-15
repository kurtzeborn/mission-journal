// Email settings.
//
// The one page in the service that is about a person rather than an archive,
// which is why it is `/email` and not `/settings`. See the note in the markup.
//
// It exists as much for the families who were here before any of this as for
// new ones: nothing on the way in asks the question, so everybody's answer is
// off until they come here, and a preference nobody can find is the same as a
// preference that is not offered. The account menu is how they find it.

/* global EmailSchedule, Page */

const { $, show, aimSignIn } = Page;

function offerSignIn() {
    aimSignIn();
    show('signin');
}

// Lifting a block, not choosing a frequency, so the whole panel goes rather
// than being left on screen saying something that has stopped being true.
async function resume() {
    const button = $('resume');
    button.disabled = true;

    const result = await EmailSchedule.call('DELETE', null, '/api/preferences/suppression');

    if (result.status === 401) return offerSignIn();

    if (!result.ok) {
        button.disabled = false;
        $('resume-said').textContent = 'That did not work. Please try again in a moment.';
        return;
    }

    $('suppressed').hidden = true;
    $('digest-as').textContent = 'We can email this address again.';
}

async function start() {
    const result = await EmailSchedule.call('GET');

    if (result.status === 401) return offerSignIn();
    if (!result.ok) return show('failed');

    const schedule = EmailSchedule.create({
        elements: {
            form: $('digest-form'),
            weekly: $('digest-weekly'),
            monthly: $('digest-monthly'),
            off: $('digest-off'),
            weekRow: $('digest-week-row'),
            weekdayRow: $('digest-weekday-row'),
            week: $('digest-week'),
            weekday: $('digest-weekday'),
            preview: $('digest-preview'),
            submit: $('digest-submit'),
            status: $('digest-as')
        },
        onUnauthorized: offerSignIn
    });
    schedule.set(result.body);
    $('suppressed').hidden = !result.body.suppressed;
    $('digest-as').textContent = result.body.email ? `Signed in as ${result.body.email}.` : '';
    $('resume').addEventListener('click', resume);

    show('ready');
}

start();
