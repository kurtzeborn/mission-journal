// Message classification. Decides whether an inbound message becomes a post,
// and for whose site.
//
// Everything here is a decision about trust, so the shape of the code follows
// the shape of the evidence: nothing is accepted because a header says so,
// only because a verdict stamped by our own inbound provider says so.

import { selectAuthResults, dmarcAligned, domainOf } from './authresults.js';

export const CLASS = {
    direct: 'direct',
    forward: 'forward',
    // A forward for a slug that has no site yet. Not a post -- it is held in
    // `pending/` and the forwarder is offered the site -- but not a rejection
    // either, which is what it used to be. See the `!members` branch below.
    bootstrap: 'bootstrap',
    rejected: 'rejected'
};

// A post that is accepted still has two possible fates: published outright, or
// held for the owner to look at. Holding is not rejection — the letter is
// kept, it just does not appear until a human says so.
export const DISPOSITION = {
    publish: 'publish',
    hold: 'hold'
};

// Exported because `ingest` reads the *recipient's* local-part to select a
// verb, and two functions that both mean "the bit before the @" must not be
// allowed to disagree about it. `domainOf` in authresults.js carries a note
// about exactly that having happened once already.
export const localPartOf = (address) => {
    const at = String(address ?? '').lastIndexOf('@');
    return at < 0 ? null : address.slice(0, at).toLowerCase();
};

const reject = (reason, extra = {}) => ({
    class: CLASS.rejected,
    disposition: null,
    slug: null,
    reason,
    ...extra
});

// Which slug's ACL the classifier is going to need. A direct send needs none —
// DMARC has already authenticated the author — so this returns null and the
// caller skips the lookup entirely. Exposed because the ACL lives in blob
// storage and has to be fetched before `classify` runs, which is synchronous
// by design: every decision it makes is a pure function of evidence in hand.
export function aclSlugFor({ extracted, config }) {
    const missionaryDomains = (config.missionaryDomains ?? []).map((d) => d.toLowerCase());
    const senderDomain = domainOf(extracted?.sender);
    if (!senderDomain || missionaryDomains.includes(senderDomain)) return null;

    const author = extracted?.original?.from ?? null;
    if (!author || !missionaryDomains.includes(domainOf(author))) return null;
    return localPartOf(author);
}

/**
 * @param {object} input
 * @param {object} input.extracted     result of extractOriginal()
 * @param {Array}  input.headers       outer message headers, [{key, value}]
 * @param {object} input.config        { authservId, missionaryDomains }
 * @param {function} input.lookupAcl   (slug) => [{ address, role }] | null
 * @param {boolean} input.dkimVerified did the embedded original's own
 *                                     signature re-verify? Computed by the
 *                                     caller, since it needs DNS.
 */
export function classify({ extracted, headers, config, lookupAcl, dkimVerified = false }) {
    const missionaryDomains = (config.missionaryDomains ?? []).map((d) => d.toLowerCase());

    // Selected by authserv-id, never by position. Absent means `none`, which
    // is not a pass — there is no fallback to a header someone else stamped.
    const auth = selectAuthResults(headers, config.authservId);
    if (!auth) return reject('no-auth-results');

    // The outer sender is who actually handed us this message: the missionary
    // for a direct send, the forwarder otherwise. It is the only party whose
    // authentication our provider evaluated, so it is the only one DMARC can
    // speak about.
    const sender = extracted.sender;
    if (!sender) return reject('no-sender');

    const senderDomain = domainOf(sender);
    const dmarc = dmarcAligned(auth, senderDomain);
    if (!dmarc.pass) return reject(dmarc.reason, { sender });

    // --- direct -----------------------------------------------------------
    // The missionary sent it themselves. The From: local-part is the slug, so
    // the target site comes from the author, never from the address it was
    // sent to.
    if (missionaryDomains.includes(senderDomain)) {
        return {
            class: CLASS.direct,
            disposition: DISPOSITION.publish,
            slug: localPartOf(sender),
            author: sender,
            forwarder: null,
            extractionSource: extracted.source,
            reason: null
        };
    }

    // --- forward ----------------------------------------------------------
    const author = extracted.original?.from ?? null;
    if (!author) return reject('no-recoverable-original', { sender });

    const authorDomain = domainOf(author);
    if (!missionaryDomains.includes(authorDomain)) {
        return reject('author-not-missionary', { sender, author });
    }

    const slug = localPartOf(author);
    const members = lookupAcl(slug);

    // No site for this missionary yet, and a forwarder cannot be on an ACL
    // that does not exist. This used to reject outright, and the reason given
    // was that "accepting forwards into a pending site is what needs the claim
    // email to exist" -- true when it was written, because nothing could tell
    // the forwarder anything had happened. The claim email exists now, so the
    // condition that decision rested on has expired, and rejecting here kills
    // the path the plan calls the one we advertise: a parent forwards the
    // first letter home and is offered the site.
    //
    // What makes it safe to accept is evidence, not intent. The forwarder's
    // own DMARC already passed above, so we know who is asking. The question
    // that remains is whether the letter they are holding is genuinely from
    // the missionary whose site they would be given -- and only a re-verified
    // signature on an embedded original answers it. Inline forwarded text is
    // forwarder-controlled and proves nothing, which is why it is refused here
    // even though an owner may use it: an owner has already been vouched for,
    // and this is the branch where nobody has.
    //
    // So a stranger cannot conjure a site for a missionary they have never
    // received mail from. They can, however, claim one for a missionary they
    // *have* -- a friend on a mass mailing holds the same evidence a parent
    // does, and no header distinguishes them. That residual risk is the
    // reason a verified missionary must be able to remove an owner.
    if (!members) {
        // Both failures now have a remedy, which was not true when this was
        // written. Inline text can be re-sent as an attachment. An attachment
        // that did not verify used to be a dead end -- the sender had already
        // followed the only advice we had -- but the cause is now known and
        // has two answers: forward again from Outlook on the web, which leaves
        // the letter's own headers alone, or have the missionary send the
        // letter directly. Both are worth a reply, and they are different ones.
        // See nudge.js.
        if (extracted.source === 'inline') {
            return reject('bootstrap-not-attached', { sender, author, slug });
        }
        if (extracted.source !== 'rfc822') {
            return reject('no-recoverable-original', { sender, author, slug });
        }
        if (!dkimVerified) {
            return reject('bootstrap-unverified', { sender, author, slug });
        }

        return {
            class: CLASS.bootstrap,
            disposition: DISPOSITION.hold,
            slug,
            author,
            forwarder: sender,
            role: null,
            extractionSource: extracted.source,
            dkimVerified,
            reason: null
        };
    }

    // Access implies forwarding rights: there is no separate allowed-forwarder
    // list to drift out of sync with the ACL. Keyed on `email`, which is the
    // field name in the stored acl.json.
    const member = members.find((m) => m.email?.toLowerCase() === sender);
    if (!member) return reject('forwarder-not-on-acl', { sender, author, slug });

    if (extracted.source !== 'inline' && extracted.source !== 'rfc822') {
        return reject('no-recoverable-original', { sender, author, slug });
    }

    // Past this point membership is the control, not the signature.
    //
    // Inline text used to be owner-only, and an attachment that did not
    // re-verify used to be held, both on the reasoning that a reader could
    // otherwise invent a letter and attribute it to the missionary. That risk
    // is real and has not changed. What changed is the price of pricing it in:
    // most of a family cannot produce a verifiable forward at all, because the
    // desktop Outlook client rebuilds every message it forwards, so the rule
    // was not admitting only trustworthy letters -- it was holding almost
    // everything from almost everybody, indefinitely, with no way out.
    //
    // The trust boundary is the invitation. Someone on this list was put there
    // by the owner, deliberately, and the owner can edit or delete anything
    // they post and remove them from the list. That is a person the family
    // chose, not a stranger, and it is a smaller risk than an archive nobody
    // can add to.
    //
    // Bootstrap is where the cryptography still earns its keep, and it is
    // untouched: it decides whether an archive exists at all, and there is no
    // owner there to appeal to.
    return {
        class: CLASS.forward,
        disposition: DISPOSITION.publish,
        slug,
        author,
        forwarder: sender,
        role: member.role,
        extractionSource: extracted.source,
        dkimVerified,
        reason: null
    };
}
