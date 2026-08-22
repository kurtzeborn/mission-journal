// The question asked before something that will not come back.
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

        // Cancel first, because a dialog gives its opening focus to the first
        // control it contains and Enter on "this cannot be undone" must not be
        // the answer that does it.
        form.append(no, yes);

        // Clicking the dark area answers Cancel, like the archive's other two
        // dialogs. A click on the backdrop is reported as a click on the
        // dialog box, which is what the test is against.
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });

        dialog.append(question, detail, form);
        document.body.append(dialog);

        asking = { dialog, question, detail, yes };
        return asking;
    }

    /**
     * Ask, and resolve true only if the answer was the action.
     *
     * The label on the button is what it will do -- `Delete`, not `OK`. It is
     * the last thing read before somebody presses it, and it is the only part
     * of the dialog that still makes sense on its own.
     *
     * @param {{question: string, detail?: string, action: string}} asked
     * @returns {Promise<boolean>}
     */
    function ask({ question, detail, action }) {
        const view = ensureAsk();
        view.question.textContent = question;
        view.yes.textContent = action;

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
                () => resolve(view.dialog.returnValue === 'yes'),
                { once: true }
            );
            view.dialog.showModal();
        });
    }

    window.Confirm = { ask };
})();
