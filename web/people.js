// The people page: who can read one archive, and the controls to change it.
//
// Everything drawn here is decided by the server. `removable` arrives on each
// row already computed, and the buttons are drawn from it rather than from any
// rule restated in this file -- a second copy of the policy would drift, and it
// would drift in the direction of offering a button that then fails. The API
// re-checks all of it on every call regardless; this decides what to draw, not
// who is allowed to do it.

(() => {
    'use strict';

    // `/people/<slug>`. Read from the path rather than a query string so the
    // page has the same shape as the archive it belongs to.
    const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '');

    const $ = (id) => document.getElementById(id);
    const state = $('state');

    const show = (message) => {
        state.textContent = message;
        state.hidden = false;
        $('everything').hidden = true;
    };

    const api = (path, init) =>
        fetch(`/api/members/${encodeURIComponent(slug)}${path}`, {
            cache: 'no-store',
            ...init
        });

    // What an undeliverable address looks like to the person reading it, in
    // the terms they can act in. Not the provider's vocabulary: "suppressed"
    // is a fact about Cloudflare's account list, and the owner's question is
    // only ever "is my mother getting these".
    //
    // One sentence for every cause. There were briefly three -- a bounce, a
    // suppression and a plain failure -- and the split did not survive contact
    // with the fact that we cannot reliably tell them apart. It also does not
    // matter: the remedy an owner has is the same in all three cases, which is
    // to check the address and then ask the person directly.
    //
    // Deliberately non-accusatory about the recipient, because the most likely
    // cause is that they pressed a spam button once, years ago, on something
    // else entirely.
    const UNDELIVERED = 'Mail is not reaching this address. Check the spelling, or ask them for another one.';

    // Kept out of the markup. Every one of these strings is either an address
    // somebody typed or a name somebody typed, so nothing here builds HTML.
    function row(person) {
        const item = document.createElement('li');
        item.className = 'people__row';

        // Dimmed rather than badged, like a hidden letter: the row is still a
        // real person with real access, and the point is that the eye lands on
        // it without the list acquiring a column that is blank for everybody
        // else.
        if (person.delivery) item.classList.add('people__row--undelivered');

        const who = document.createElement('span');
        who.className = 'people__who';
        who.textContent = person.email;

        // The address the invitation was sent to, when the person signed in
        // with a different one. Without this the row is unidentifiable: an
        // owner who invited grandma@aol.com has no way to tell that the
        // gmail address in front of them is her, and Remove is a button you
        // have to be sure about before you press it.
        if (person.invitedEmail) {
            const was = document.createElement('span');
            was.className = 'people__was';
            was.textContent = `invited as ${person.invitedEmail}`;
            who.appendChild(document.createElement('br'));
            who.appendChild(was);
        }

        item.appendChild(who);

        const what = document.createElement('span');
        what.className = 'people__what';
        what.textContent = person.pending
            ? `invited as ${person.role}`
            : person.verifiedMissionary
              ? 'the missionary'
              : person.role;
        item.appendChild(what);

        const controls = document.createElement('span');
        controls.className = 'people__controls';

        // Where a refused action says why. Lives in the row rather than in the
        // form's status line at the bottom of the page, because the answer to
        // "why did nothing happen" has to be next to the thing that did
        // nothing.
        const trouble = document.createElement('span');
        trouble.className = 'note people__trouble';
        trouble.hidden = true;

        if (!person.pending && person.removable) {
            controls.appendChild(
                button(person.role === 'owner' ? 'Make reader' : 'Make owner', async () => {
                    await api(`/${encodeURIComponent(person.email)}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role: person.role === 'owner' ? 'reader' : 'owner' })
                    });
                }, trouble)
            );
        }

        if (person.pending) {
            controls.appendChild(
                button('Resend', async () => {
                    // No confirmation. The consequence of an accidental press
                    // is one duplicate email to somebody who was already being
                    // invited, which is a smaller cost than a dialog in front
                    // of the button people came here to press.
                    const response = await api(`/${encodeURIComponent(person.id)}/resend`, {
                        method: 'POST'
                    });
                    if (response.ok) return;

                    // The refusals this one can actually hit are the daily cap
                    // and an opt-out, both of which are about the recipient
                    // rather than about the owner doing something wrong.
                    const body = await response.json().catch(() => ({}));
                    return body.error ?? 'could not send that again';
                }, trouble)
            );
        }

        if (person.pending || person.removable) {
            controls.appendChild(
                button('Remove', async () => {
                    // The one destructive control on the page, and the one
                    // whose consequence is invisible: the person is simply
                    // gone the next time they look.
                    const sure = person.pending
                        ? `Withdraw the invitation to ${person.email}?`
                        : `Remove ${person.email} from this archive?\n\nThey will no longer be able to read the letters. Nothing is emailed to them.`;
                    if (!window.confirm(sure)) return 'cancelled';
                    await api(`/${encodeURIComponent(person.pending ? person.id : person.email)}`, {
                        method: 'DELETE'
                    });
                }, trouble)
            );
        } else if (!person.pending) {
            const why = document.createElement('span');
            why.className = 'note';
            // Said rather than left blank. A row with no buttons next to rows
            // that have them reads as a bug.
            why.textContent = person.you
                ? 'this is you'
                : 'verified, cannot be removed';
            controls.appendChild(why);
        }

        item.appendChild(controls);
        item.appendChild(trouble);

        // Last, so it reads as a note under the whole row rather than as a
        // failure of whichever button happens to sit above it. It is not put in
        // `trouble`, which belongs to the buttons and is cleared on the next
        // press -- this one is a standing fact about the address.
        if (person.delivery) {
            const undelivered = document.createElement('span');
            undelivered.className = 'people__undelivered';
            undelivered.textContent = UNDELIVERED;
            item.appendChild(undelivered);
        }

        return item;
    }

    // Refusals that are true but read like a malfunction unless you know the
    // rule behind them. The questions page has the rule; these are the anchors
    // that reach it. An owner told "has asked us not to email them" about
    // their own mother is owed the sentence explaining that it was her doing
    // and not ours.
    const EXPLAINED = {
        'has asked us not to email them': '/faq#stop-emails',
        'too many invitations today, try again tomorrow': '/faq#adding-family'
    };

    // An action may return a string to mean "this did not happen, and here is
    // why". Anything else means it did, and the list is reloaded to show it.
    //
    // `cancelled` is the one string that reports nothing, because the person
    // who dismissed the confirmation already knows what they chose.
    function button(label, action, trouble) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'button button--quiet button--compact';
        el.textContent = label;
        el.addEventListener('click', async () => {
            el.disabled = true;
            if (trouble) trouble.hidden = true;

            let outcome;
            try {
                outcome = await action();
            } catch {
                outcome = 'could not reach the server';
            }

            if (typeof outcome === 'string') {
                el.disabled = false;
                if (trouble && outcome !== 'cancelled') {
                    trouble.textContent = `${outcome} `;
                    if (EXPLAINED[outcome]) {
                        const why = document.createElement('a');
                        why.href = EXPLAINED[outcome];
                        why.textContent = 'Why?';
                        trouble.appendChild(why);
                    }
                    trouble.hidden = false;
                }
                return;
            }

            await load();
        });
        return el;
    }

    async function load() {
        let response;
        try {
            response = await api('');
        } catch {
            show('Could not load this page. Please try again.');
            return;
        }

        if (response.status === 401) {
            // Through the chooser, never straight at a provider. There are two
            // now, and sending a Google owner to Microsoft strands them on an
            // account that has never heard of this archive -- with a page that
            // then tells them, correctly and uselessly, that they are not the
            // owner.
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return;
        }
        if (response.status === 403) {
            show('Only owners can see who has access to an archive.');
            return;
        }
        if (!response.ok) {
            show('This archive is not available to you.');
            return;
        }

        const payload = await response.json();
        const list = $('people');
        list.textContent = '';

        for (const person of payload.members) list.appendChild(row(person));
        // Invitations after members, and marked, because an invitation is an
        // offer rather than access and the difference has to be visible.
        for (const invited of payload.invites) list.appendChild(row({ ...invited, pending: true }));

        state.hidden = true;
        $('everything').hidden = false;
    }

    // Pulls addresses out of whatever got pasted.
    //
    // Written to accept the shapes people actually have rather than to be a
    // parser: a comma-separated line out of an old email, a column copied from
    // a spreadsheet, `Aunt Kay <kay@example.com>` straight from a mail client,
    // or all three at once. Names and stray punctuation are dropped rather
    // than rejected, because a paste that fails wholesale over one trailing
    // semicolon sends somebody back to retype the lot.
    //
    // Nothing here decides whether an address is real. That is the server's
    // job and it does it again anyway; this only decides where one address
    // ends and the next begins.
    function parseAddresses(text) {
        const found = [];
        for (const chunk of String(text ?? '').split(/[\n,;]+/)) {
            // The angle-bracket form wins when present: `Kay <kay@x.com>` has
            // a name that could otherwise be mistaken for an address.
            const angled = chunk.match(/<([^>]*)>/);
            const candidate = (angled ? angled[1] : chunk).trim().replace(/^["']|["']$/g, '');
            if (candidate) found.push(candidate.toLowerCase());
        }
        // Deduped because the same relative appears twice in a pasted list far
        // more often than not, and every duplicate would otherwise spend one
        // of the day's twenty invitations to be refused.
        return [...new Set(found)];
    }

    async function invite(event) {
        event.preventDefault();
        const said = $('invite-said');
        const trouble = $('invite-trouble');
        const submit = $('invite-submit');

        trouble.textContent = '';
        trouble.hidden = true;

        const addresses = parseAddresses($('email').value);
        if (!addresses.length) {
            said.textContent = 'No email addresses found in that.';
            return;
        }

        submit.disabled = true;
        const role = $('role').value;
        const refused = [];
        let sent = 0;

        // One at a time, deliberately.
        //
        // The daily cap is a read-then-check with no atomic counter behind it,
        // so a dozen requests in flight together can each read the same count
        // and all pass. Sequential sending is what makes the cap mean exactly
        // what it says on the path most likely to reach it. It is also the
        // only way to tell somebody *which* addresses failed.
        for (const email of addresses) {
            said.textContent =
                addresses.length > 1
                    ? `Sending ${sent + refused.length + 1} of ${addresses.length}\u2026`
                    : 'Sending\u2026';

            let response;
            try {
                response = await api('', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, role })
                });
            } catch {
                refused.push({ email, why: 'could not reach the server' });
                continue;
            }

            const body = await response.json().catch(() => ({}));
            if (response.ok) {
                sent++;
                continue;
            }

            // The server's own words. Every refusal it produces is already a
            // sentence written for the person reading it, and translating them
            // here would mean maintaining the same list twice.
            refused.push({ email, why: body.error ?? 'did not go through' });
        }

        submit.disabled = false;

        // Deliberately does not claim the mail arrived. It has been handed to
        // the provider, which is a different thing, and telling somebody their
        // invitation was delivered when it went to spam sends them looking in
        // the wrong place.
        said.textContent = sent
            ? `${sent === 1 ? 'Invitation' : `${sent} invitations`} sent. ${sent === 1 ? 'It works' : 'They work'} for two weeks.`
            : 'Nothing was sent.';

        // Named one by one rather than counted. "3 failed" is the message that
        // makes somebody paste the whole list again to find out which three.
        for (const { email, why } of refused) {
            const line = document.createElement('li');
            line.textContent = `${email} \u2014 ${why}`;
            trouble.appendChild(line);
        }
        trouble.hidden = refused.length === 0;

        // Only cleared when the whole list went through. Leaving the refusals
        // in the box is what lets somebody fix a typo and press send again,
        // and clearing it would throw away the addresses that still need one.
        if (!refused.length) $('email').value = '';
        else $('email').value = refused.map((r) => r.email).join('\n');

        await load();
    }

    if (!slug) {
        show('No archive was named.');
    } else {
        $('back').href = `/${encodeURIComponent(slug)}/`;
        $('invite').addEventListener('submit', invite);
        load();
    }
})();
