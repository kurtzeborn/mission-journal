// The four or five lines every small page repeats.
//
// A file of its own for the same reason confirm.js is one: these were copied
// rather than shared, and a copy nobody is looking at is the one that drifts.
// `takeToken` is the one that matters -- it is the only thing standing between
// a signed link and the address bar, the access log, App Insights, the Referer
// header, and a support conversation somebody pastes a whole URL into. Four
// identical copies of that is four places to get a security fix half applied.
//
// The pages that load this are the ones an email link lands on -- claim,
// invite, opt-out, ask -- plus the email settings page, which shares
// everything here except the token. All five are a stack of `<section>`s of
// which exactly one is visible, which is what `show` is for.
//
// A classic script assigning to `window`, not a module, because every page in
// this service loads as `<script src>` and the anonymous ones each need a
// route rule in staticwebapp.config.json. See confirm.js for the same shape.

(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);

    // One section visible at a time. Every page here is a small state machine
    // -- working, ready, failed -- drawn as sections rather than as markup
    // built in JavaScript, so the wording lives in the HTML where it can be
    // read.
    const show = (id) => {
        for (const section of document.querySelectorAll('main > section')) section.hidden = true;
        $(id).hidden = false;
    };

    // The token arrives in the URL fragment and is moved straight into
    // sessionStorage, then stripped from the address bar. sessionStorage
    // rather than a variable because some of these pages send the visitor off
    // to sign in and back again, and the fragment does not reliably survive
    // that round trip; a same-origin session value does.
    //
    // `key` differs per page so two links open in two tabs cannot overwrite
    // each other's token.
    const takeToken = (key) => {
        const fromHash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
        if (fromHash) {
            sessionStorage.setItem(key, fromHash);
            history.replaceState(null, '', location.pathname);
            return fromHash;
        }
        return sessionStorage.getItem(key) ?? '';
    };

    // Point the two provider buttons back at this page. Only the hrefs --
    // revealing them differs by page, and so does what else has to happen
    // first, so that stays with the caller.
    const aimSignIn = () => {
        const back = encodeURIComponent(location.pathname);
        $('signin-aad').href = `/.auth/login/aad?post_login_redirect_uri=${back}`;
        $('signin-google').href = `/.auth/login/google?post_login_redirect_uri=${back}`;
    };

    window.Page = { $, show, takeToken, aimSignIn };
})();
