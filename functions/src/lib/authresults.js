// RFC 8601 Authentication-Results parsing.
//
// This is authentication-bearing code, so the parsing rules below are security
// boundaries rather than robustness niceties. A message can contain any number
// of Authentication-Results headers, and every one of them except the header
// our own inbound provider stamped is attacker-supplied text that looks
// exactly as official as the real one.

// A result is `method=value` optionally followed by `ptype.property=value`
// pairs. The method may carry a version, as in `dkim/1=pass`.
const METHOD_START = /^[a-z][a-z0-9-]*(\/\d+)?=/i;

// Comments are free text and may contain semicolons, equals signs and
// parentheses of their own. Real ones do: Cloudflare writes
// `spf=none (mx.cloudflare.net: no SPF records found for postmaster@...)`.
// They have to come out before anything is split, and nesting has to be
// tracked or the first `)` ends the comment early.
function stripComments(value) {
    let out = '';
    let depth = 0;
    let quoted = false;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (quoted) {
            if (c === '\\') i++;
            else if (c === '"') quoted = false;
            if (!depth) out += c;
            continue;
        }
        if (c === '"' && !depth) {
            quoted = true;
            out += c;
            continue;
        }
        if (c === '(') {
            depth++;
            continue;
        }
        if (c === ')') {
            if (depth) depth--;
            continue;
        }
        if (!depth) out += c;
    }
    return out;
}

const unfold = (value) => String(value ?? '').replace(/\r?\n[ \t]+/g, ' ');

/**
 * Parse a single Authentication-Results header value.
 *
 * Returns `authservId: null` when the header omits the identifier. Exchange
 * Online does exactly this, opening straight into `spf=pass`. RFC 8601
 * requires the field, but real senders violate it, and a header that does not
 * say who produced it is not evidence about any particular path.
 */
export function parseAuthenticationResults(value) {
    const text = stripComments(unfold(value)).trim();
    const segments = text.split(';');
    const first = (segments[0] ?? '').trim();

    let authservId = null;
    let rest = segments;
    if (first && !METHOD_START.test(first)) {
        // The identifier may be followed by a version number.
        authservId = first.split(/\s+/)[0].toLowerCase();
        rest = segments.slice(1);
    }

    const results = [];
    for (const segment of rest) {
        const tokens = segment.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) continue;
        const head = tokens[0];
        const eq = head.indexOf('=');
        if (eq <= 0) continue;

        const method = head.slice(0, eq).split('/')[0].toLowerCase();
        const result = head.slice(eq + 1).toLowerCase();
        const properties = new Map();
        for (const token of tokens.slice(1)) {
            const at = token.indexOf('=');
            if (at <= 0) continue;
            const key = token.slice(0, at).toLowerCase();
            let val = token.slice(at + 1);
            if (val.startsWith('"') && val.endsWith('"') && val.length > 1) {
                val = val.slice(1, -1);
            }
            properties.set(key, val);
        }
        results.push({ method, result, properties });
    }

    return { authservId, results };
}

/**
 * Pick the header stamped by our own inbound provider.
 *
 * Three rules, each of which a real capture in the corpus would defeat if it
 * were relaxed:
 *
 *   - Exact header name. `ARC-Authentication-Results` contains
 *     `Authentication-Results` as a substring and carries the same
 *     authserv-id, and it appears immediately *above* the real header in every
 *     Cloudflare capture. An unanchored match reads the ARC copy every time.
 *   - Match on authserv-id, never on position. The topmost header in every
 *     fixture is `mx.google.com`, stamped after our ingest path.
 *   - A header with no authserv-id matches nothing. No default, no fallback.
 *
 * The first header bearing the expected identifier wins: our provider prepends
 * its stamp at delivery, so anything a sender forged sits below it.
 */
export function selectAuthResults(headers, authservId) {
    if (!authservId) return null;
    const wanted = authservId.toLowerCase();
    for (const header of headers ?? []) {
        const key = String(header.key ?? '').toLowerCase();
        if (key !== 'authentication-results') continue;
        const parsed = parseAuthenticationResults(header.value);
        if (parsed.authservId === wanted) return parsed;
    }
    return null;
}

/**
 * Look up one result by method and, where a method can appear more than once,
 * by the property that distinguishes the instances.
 *
 * Real `missionary.org` mail arrives with `spf=none` for `smtp.helo`
 * immediately followed by `spf=pass` for `smtp.mailfrom`. Taking the first
 * `spf=` match rejects a fully authenticated letter, so a caller that cares
 * about SPF must name `smtp.mailfrom`.
 */
export function resultOf(parsed, method, property) {
    if (!parsed) return null;
    const candidates = parsed.results.filter((r) => r.method === method);
    if (!candidates.length) return null;
    if (!property) return candidates[0];
    // A method with no matching property is absent, not failed.
    return candidates.find((r) => r.properties.has(property)) ?? null;
}

export const domainOf = (address) => {
    const at = String(address ?? '').lastIndexOf('@');
    if (at < 0) return null;
    // The trailing dot of a fully-qualified name is stripped, because
    // `missionary.org.` and `missionary.org` are the same domain and only one
    // of them will ever be typed into a config setting. This was previously
    // done here one way and in dkim.js another, which left two functions with
    // the same name quietly disagreeing about what a domain is.
    return address.slice(at + 1).toLowerCase().replace(/\.$/, '');
};

/**
 * DMARC is the composite verdict: it passes when SPF or DKIM aligns with the
 * From: domain. Requiring all three to pass independently adds no security
 * over DMARC alone while rejecting legitimate mail, because forwarding
 * rewrites the envelope sender and breaks SPF by design.
 *
 * Alignment is re-checked here rather than trusted: the header reports which
 * domain it evaluated, and that must be the domain we are about to make a
 * trust decision about.
 */
export function dmarcAligned(parsed, fromDomain) {
    const domain = String(fromDomain ?? '').toLowerCase();
    if (!parsed || !domain) return { pass: false, reason: 'no-auth-results' };

    const dmarc = resultOf(parsed, 'dmarc');
    if (!dmarc) return { pass: false, reason: 'no-dmarc-result' };
    if (dmarc.result !== 'pass') return { pass: false, reason: `dmarc-${dmarc.result}` };

    const evaluated = (dmarc.properties.get('header.from') ?? '').toLowerCase();
    if (!evaluated) return { pass: false, reason: 'dmarc-no-header-from' };
    if (evaluated !== domain) return { pass: false, reason: 'dmarc-misaligned' };

    return { pass: true, reason: null, policy: dmarc.properties.get('policy.dmarc') ?? null };
}
