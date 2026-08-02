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
    rejected: 'rejected'
};

// A post that is accepted still has two possible fates: published outright, or
// held for the owner to look at. Holding is not rejection — the letter is
// kept, it just does not appear until a human says so.
export const DISPOSITION = {
    publish: 'publish',
    hold: 'hold'
};

const localPartOf = (address) => {
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
    if (!members) return reject('unknown-slug', { sender, author, slug });

    // Access implies forwarding rights: there is no separate allowed-forwarder
    // list to drift out of sync with the ACL.
    const member = members.find((m) => m.address?.toLowerCase() === sender);
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
