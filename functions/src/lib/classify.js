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
        // Two different failures, and only one of them has a remedy the sender
        // can act on. Inline text can be re-sent as an attachment, so that one
        // is worth a reply. An embedded original whose signature did not
        // re-verify was already forwarded correctly -- telling that sender to
        // "forward as an attachment" is advice they have followed, and would
        // send them round the same loop indefinitely. The causes there are a
        // client that rewrote the body, a signature stripped in transit, or a
        // key rotated since the letter was sent, and none of them are fixable
        // from the sender's chair.
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

    const isOwner = member.role === 'owner';

    // Inline forwarded text is forwarder-controlled and carries no evidence of
    // authorship. A reader could otherwise invent a letter, attribute it to
    // the missionary and backdate it anywhere in the timeline. Owners can
    // already edit and delete any post, so this grants them nothing new.
    if (extracted.source === 'inline' && !isOwner) {
        return reject('inline-requires-owner', { sender, author, slug });
    }

    if (extracted.source !== 'inline' && extracted.source !== 'rfc822') {
        return reject('no-recoverable-original', { sender, author, slug });
    }

    // An embedded original whose signature does not re-verify is exactly as
    // forgeable as inline text, so it is held rather than published. It is not
    // dropped: re-verification fails for honest reasons too, including a
    // client that strips the signature and a signing key rotated since the
    // letter was sent.
    const disposition =
        isOwner || dkimVerified ? DISPOSITION.publish : DISPOSITION.hold;

    return {
        class: CLASS.forward,
        disposition,
        slug,
        author,
        forwarder: sender,
        role: member.role,
        extractionSource: extracted.source,
        dkimVerified,
        reason: disposition === DISPOSITION.hold ? 'unverified-original' : null
    };
}
