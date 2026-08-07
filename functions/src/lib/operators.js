// Who may act on a site they do not belong to.
//
// Several things this service promises have no actor otherwise: deleting a
// site after an abuse report, settling an ownership dispute the 60-day window
// has already closed on, re-rendering history after a sanitizer fix, or
// walking a stuck owner through an invitation they cannot get to work. All of
// them mean acting on an archive the actor is not a member of.
//
// **This is configuration, not data, and that is the whole security argument.**
// A privilege this broad must not be grantable through the interface it
// grants. If the operator list lived in a blob or a table, one compromised
// operator account could quietly add a second and make the escalation
// permanent and self-sustaining. As an app setting it takes Azure
// control-plane access to change -- a separate credential, separately recorded
// in the Activity Log -- and there is deliberately no UI for editing it.
//
// **Nothing is ever written to a site's `acl.json` or `memberships` for an
// operator.** That single choice does most of the work: operators never appear
// in an owner's People list, never populate the switcher or the root archive
// list, and the owner admin pages need no operator-specific variant. An
// operator reaches a site by typing its URL.
//
// **The email path does not consult this at all.** Ingest resolves forwarding
// rights from `acl.json` alone, so being an operator does not confer the
// ability to publish into a stranger's archive by email. A `From:` header,
// even a DMARC-passing one, is a far weaker identity signal than a signed-in
// session, and there is no scenario where an operator needs to author content
// on somebody else's site rather than administer it.

/**
 * Parse `OPERATOR_EMAILS`.
 *
 * Commas, semicolons and whitespace all separate, because this is typed into
 * an Azure portal text box by a human who will not be reading a format
 * specification at the time.
 *
 * **Unset means nobody**, which is the correct default and the one every
 * environment except production runs with. An empty setting must never mean
 * "everybody", so the parse produces an empty set rather than a wildcard.
 *
 * @returns {Set<string>} lowercased addresses
 */
export function operatorEmails(env = process.env) {
    return new Set(
        String(env?.OPERATOR_EMAILS ?? '')
            .split(/[,;\s]+/)
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
    );
}

/**
 * Not memoized on purpose.
 *
 * Splitting a forty-character string is far cheaper than the blob read it sits
 * beside, and a cached copy would mean an operator removed from the setting
 * keeps their access until the host happens to recycle -- which is exactly the
 * moment the removal matters most.
 */
export function isOperator(email, env = process.env) {
    if (!email) return false;
    return operatorEmails(env).has(String(email).toLowerCase());
}
