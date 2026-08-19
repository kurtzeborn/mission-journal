// The last mile: handing a finished book to somebody who can print it.
//
// Peecho's API has two shapes and they are not variants of each other. One
// creates an order and pays for it out of prepaid credits, which would make
// us the merchant -- taking the card, the refunds and the fraud, and holding
// a stranger's postal address in our storage account. The other creates a
// *product listing-publication*: a page on Peecho's own checkout where the
// buyer pays Peecho, Peecho prints and ships, and we are told an order
// happened. That second one is the whole reason this provider was chosen, and
// it is the only one this file knows how to do.
//
// So nothing here takes a payment, and nothing here has ever seen an address.
// What crosses the wire is a title, a page count and a URL to a PDF.
//
// **The account is live, and this has been run against it exactly once.** A
// create-publication call returned a real secure publication id and a real
// checkout page. What blocked it for a while was Peecho's Company details
// form, which demands a VAT number a US sole trader does not have; the answer
// turned out to be that the API does not want that form at all -- Billing
// Information and Billing Address, neither of which asks for VAT, are what
// clears `APP_NO_COMP_DETAILS`. It is still switched off in production, but
// now only because the order button is not built yet.
//
// Every field name below is theirs verbatim, including the snake_case in the
// webhook payloads sitting next to the camelCase in the request: guessing at
// a rename is how an integration nobody can run today becomes an integration
// nobody can debug tomorrow.

import { createHash, timingSafeEqual } from 'node:crypto';

// Their test environment is a genuinely separate account with its own keys,
// and orders placed in it are never printed and never charged. It is the
// default here rather than the exception, because the failure mode of the
// other default is a real book printed and shipped by a test. Separate is
// meant literally: the live merchant key is not recognised here at all, so
// using this base means registering for it first.
export const TEST_BASE = 'https://test.www.peecho.com';

// US Letter portrait as Peecho lists it, in millimetres. Informational for a
// listing that pins a product by id -- they use it for the preview and the
// spine -- but wrong numbers here would show the buyer the wrong book.
export const TRIM_MM = { width: 216, height: 280 };

// Long enough that a family passing the link round at Christmas can still use
// it, short enough that a link found in an old email is not a permanent open
// checkout. Peecho takes the expiry in its own format and its own timezone.
export const CHECKOUT_DAYS = 60;

/**
 * `dd-MM-yyyy HH:mm:ss`, in CET, which is what their field asks for.
 *
 * Formatted through `Intl` rather than by hand because "CET" is not a fixed
 * offset -- half the year it is CEST -- and an hour's drift on an expiry
 * nobody watches is exactly the kind of bug that is only ever found by the
 * person it locks out.
 */
export function checkoutExpiry(at) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })
        .formatToParts(at)
        .reduce((all, part) => ({ ...all, [part.type]: part.value }), {});

    return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// One string that says which book an order is for, because that is all we get
// back. Their only rule is that it is unique per merchant, which a slug and a
// book id already are.
//
// Split on the *last* separator: a book id is a timestamp and four bytes of
// hex joined by a single hyphen, so it can never contain a double one, while
// nothing stops a slug from being read as anything else.
export const orderReference = (slug, id) => `${slug}--${id}`;

export function readReference(reference) {
    const text = String(reference ?? '');
    const cut = text.lastIndexOf('--');
    if (cut <= 0) return null;

    return { slug: text.slice(0, cut), id: text.slice(cut + 2) };
}

/**
 * The body of a create-publication request.
 *
 * Pure, and separate from sending it, because this is the part worth being
 * able to assert on: it is the only description of the book that ever leaves
 * this service, and it is going to a printer.
 *
 * `enableSecureCheckout` is not optional here, whatever their default is.
 * These are private books -- a family's letters, photographs of their
 * children -- and an ordinary publication lives at `peecho.com/print/{id}`
 * where the id is a small integer. Secure checkout swaps that for a UUID and
 * a token, which is the difference between a private page and a page that
 * happens not to be linked to.
 */
export function publicationBody({
    apiKey,
    slug,
    id,
    title,
    fileUrl,
    pages,
    currency = 'USD',
    offeringId = '',
    offeringPrice = '',
    category = '',
    baseUrl = '',
    expiresAt
}) {
    const body = {
        apiKey,
        order: {
            reference: orderReference(slug, id),
            product: {
                title,
                source: {
                    file: {
                        // One PDF, covers included, which is the form their
                        // uploader asks for and the form the builder makes.
                        src: fileUrl,
                        pages,
                        dimensions: { width: TRIM_MM.width, height: TRIM_MM.height }
                    }
                }
            }
        },
        currency,
        locale: 'en',
        enableSecureCheckout: true,
        secureCheckoutExpirationDate: checkoutExpiry(expiresAt)
    };

    // Either the exact product at a price we set, or a category the buyer
    // chooses within at the markup on the account. The first is what we want
    // and the second is what works before somebody has looked up an offering
    // id in the dashboard, so both are supported and neither is invented.
    if (offeringId) {
        body.fixedOfferingId = String(offeringId);
        if (offeringPrice) body.fixedOfferingPrice = String(offeringPrice);
    } else if (category) {
        body.filterCategory = category;
    }

    // Where the buyer lands afterwards. Back at the book page in all three
    // cases: it is the page they came from, it is owners-only, and it is the
    // only page in this service that knows what a book is.
    if (baseUrl) {
        const back = `${baseUrl}/book/${encodeURIComponent(slug)}`;
        body.redirect = {
            thankyou: { href: `${back}?ordered=1` },
            cancellation: { href: back },
            error: { href: back }
        };
    }

    return body;
}

/**
 * Create the listing and work out where to send the buyer.
 *
 * Their success body is one of two things: a bare publication id, or -- with
 * secure checkout on, which is always -- an object carrying an id and a
 * token. Both are handled because their documentation shows both under the
 * same 200, and an integration that only understands the shape it expected is
 * one deployment away from being wrong.
 *
 * @returns {Promise<{error: string} | {publicationId: string, checkoutUrl: string}>}
 */
export async function createPublication({ base = TEST_BASE, body, fetchImpl = fetch, log }) {
    let response;
    let payload;

    try {
        response = await fetchImpl(`${base}/rest/v3/publication/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        payload = await response.json().catch(() => null);
    } catch (error) {
        log?.error?.('peecho.unreachable', { message: error.message });
        return { error: 'the printer could not be reached' };
    }

    if (!response.ok) {
        // Their own code, logged rather than shown. `APP_NO_COMP_DETAILS` and
        // `APP_FORBIDDEN` are both about our account and neither means
        // anything to the owner looking at the page.
        log?.error?.('peecho.refused', {
            status: response.status,
            code: payload?.custom_code ?? '',
            details: payload?.details ?? ''
        });
        return { error: 'the printer would not take this book' };
    }

    const secureId = payload?.secure_publication_id ?? '';
    const token = payload?.token ?? '';

    if (secureId && token) {
        return {
            publicationId: secureId,
            checkoutUrl: `${base}/checkout/print/en/${encodeURIComponent(secureId)}?token=${encodeURIComponent(token)}`
        };
    }

    const plain = typeof payload === 'object' ? (payload?.id ?? payload?.publication_id) : payload;
    if (!plain) {
        log?.error?.('peecho.unreadable', { status: response.status });
        return { error: 'the printer said something we could not read' };
    }

    return {
        publicationId: String(plain),
        checkoutUrl: `${base}/print/${encodeURIComponent(String(plain))}`
    };
}

/**
 * Is this webhook really from Peecho?
 *
 * `sha256(secretKey + order_id)`, hex, which is their scheme and not ours. It
 * is weaker than an HMAC over the body -- it authenticates the order id and
 * nothing else, so a status can be replayed but not invented -- and it is
 * what they send, so it is what is checked.
 *
 * Compared in constant time and only after the lengths match, because
 * `timingSafeEqual` throws on a mismatch and throwing is itself an oracle.
 */
export function signatureMatches({ secret, orderId, signature }) {
    if (!secret || !orderId || !signature) return false;

    const expected = createHash('sha256')
        .update(`${secret}${orderId}`, 'utf8')
        .digest('hex');

    const given = Buffer.from(String(signature), 'utf8');
    const mine = Buffer.from(expected, 'utf8');

    if (given.length !== mine.length) return false;
    return timingSafeEqual(given, mine);
}
