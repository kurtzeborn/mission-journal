// The question asked before something the owner should see coming.
//
// Usually that is something which will not come back -- a deleted letter, an
// edit thrown away, somebody's access withdrawn. It is also how an explanation
// gets in front of an action rather than after it, which is why the button has
// a calm tone as well as a grave one and why an answer can be remembered.
//
// window.confirm() did this in one line, and the line was the problem: it
// draws the browser's dialog, not the site's -- titled with the origin, set in
// the system face, and on a phone arriving as a sheet that looks like it came
// from somewhere other than the page that asked. The wrong tone for a question
// about somebody's letters, and the same chrome a scam site would use.
//
// A real <dialog>, for the reasons the reader's lightbox is one: focus
// trapping, Escape, and inertness of the page behind it come for free and are
// tedious to get subtly right by hand.
//
// A file of its own because two pages ask -- the archive, before deleting a
// letter or throwing an edit away, and the people page, before taking away
// somebody's access. The alternative was the same seventy lines twice, and the
// copy that was not being looked at would be the one that drifted.
//
// The cost is that the answer arrives later than the question, so every caller
// has to await it.

(() => {
    'use strict';

    let asking = null;

    // A ticked box has to outlive the tab it was ticked in, so it goes to
    // storage rather than a variable. Both directions are guarded: reading and
    // writing localStorage throw outright in browsers configured to refuse it,
    // and being asked once more is not worth failing an errand over.
    function recall(key) {
        try {
            return localStorage.getItem(key) === 'yes';
        } catch {
            return false;
        }
    }

    function keep(key) {
        try {
            localStorage.setItem(key, 'yes');
        } catch {
            // Asked again next time, which is the safe way to be wrong.
        }
    }

    function ensureAsk() {
        if (asking) return asking;

        const dialog = document.createElement('dialog');
        dialog.className = 'ask';

        const question = document.createElement('h2');
        question.className = 'ask__question';
        question.id = 'ask-question';
        dialog.setAttribute('aria-labelledby', question.id);

        const detail = document.createElement('p');
        detail.className = 'ask__detail';

        // method="dialog" so the buttons close it and set returnValue without
        // a listener each, and so Escape comes out of the same `close` event
        // they do rather than needing a second path to the same answer.
        const form = document.createElement('form');
        form.setAttribute('method', 'dialog');
        form.className = 'ask__buttons';

        const no = document.createElement('button');
        no.type = 'submit';
        no.value = 'no';
        no.className = 'ask__button';
        no.textContent = 'Cancel';

        const yes = document.createElement('button');
        yes.type = 'submit';
        yes.value = 'yes';
        yes.className = 'ask__button ask__button--go';

        // Drawn only for the questions that will be asked again. There is no
        // stopping the one asked before a letter is deleted.
        const again = document.createElement('label');
        again.className = 'ask__again';

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'ask__box';

        const boxLabel = document.createElement('span');
        boxLabel.textContent = 'Don\u2019t show this again';
        again.append(box, boxLabel);

        // Cancel ahead of the action, because a dialog gives its opening focus
        // to the first control it contains and Enter on "this cannot be undone"
        // must not be the answer that does it. The checkbox sits ahead of both
        // and takes that focus on the questions that show it, which is safe:
        // Enter still submits through the first submit button, which is Cancel.
        form.append(again, no, yes);

        // Clicking the dark area answers Cancel, like the archive's other two
        // dialogs. A click on the backdrop is reported as a click on the
        // dialog box, which is what the test is against.
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });

        dialog.append(question, detail, form);
        document.body.append(dialog);

        asking = { dialog, question, detail, yes, again, box };
        return asking;
    }

    /**
     * Ask, and resolve true only if the answer was the action.
     *
     * The label on the button is what it will do -- `Delete`, not `OK`. It is
     * the last thing read before somebody presses it, and it is the only part
     * of the dialog that still makes sense on its own.
     *
     * `tone` is `grave` for the losses and `calm` for a question that is a step
     * on the way to something wanted, where a red button would read as a
     * warning about the thing the owner just chose to do.
     *
     * `remember` names a storage key and offers a way to stop being asked. A
     * question already answered that way resolves true without drawing
     * anything, so a caller cannot tell it from a fresh yes.
     *
     * @param {{question: string, detail?: string, action: string,
     *   tone?: 'grave'|'calm', remember?: string}} asked
     * @returns {Promise<boolean>}
     */
    function ask({ question, detail, action, tone = 'grave', remember }) {
        if (remember && recall(remember)) return Promise.resolve(true);

        const view = ensureAsk();
        view.question.textContent = question;
        view.yes.textContent = action;
        view.yes.classList.toggle('ask__button--calm', tone === 'calm');

        view.again.hidden = !remember;
        view.box.checked = false;

        // Some questions answer themselves -- "Withdraw the invitation to
        // ada@example.com?" needs no second sentence, and an empty paragraph
        // below it is a gap that reads as something failing to load.
        view.detail.textContent = detail ?? '';
        view.detail.hidden = !detail;

        return new Promise((resolve) => {
            // Cleared rather than trusted: the element is reused, and a `yes`
            // left over from the last question would turn the next Escape into
            // an answer nobody gave.
            view.dialog.returnValue = '';
            view.dialog.addEventListener(
                'close',
                () => {
                    const said = view.dialog.returnValue === 'yes';
                    // Only a yes is worth remembering. A remembered Cancel
                    // would be a button that silently stopped working.
                    if (said && remember && view.box.checked) keep(remember);
                    resolve(said);
                },
                { once: true }
            );
            view.dialog.showModal();
        });
    }

    window.Confirm = { ask };
})();
