// Letting go of letters nobody claimed.
//
// A pending site is a promise we made without being asked: somebody sent mail
// to a slug that did not exist, and rather than dropping it we held it and
// tried to find its owner. That promise has to end somewhere. Holding a
// stranger's family correspondence indefinitely because nobody ever replied
// to an email is not caution, it is accumulation -- and the letters we are
// holding are exactly the kind of thing that should not sit in someone
// else's storage account forever.
//
// This is the only code in the system that destroys a letter, so its bias
// runs the other way from everything else here. Every ambiguity resolves to
// *keep*. A manifest that will not parse, a date that will not read, a site
// that was claimed but still has letters in it -- all of those are kept and
// logged, because the cost of keeping something too long is storage and the
// cost of deleting something too early is unrecoverable.
//
// Blob soft-delete is enabled on the account with a thirty-day window, so a
// mistake here is recoverable for a month. That is a backstop, not a licence.

const DAY_MS = 24 * 60 * 60 * 1000;

// Time past `expiresAt` before anything is actually removed.
//
// This exists because of a promise made elsewhere: `describeClaim` returns
// the slug for an *expired* token rather than pretending it never existed,
// specifically so the page can offer to send a fresh link. Purging at the
// instant of expiry would make that offer unkeepable -- the page would say
// "your link expired, here is a new one" about letters that no longer exist.
// A week is long enough for somebody who opens their mail on Sunday.
export const GRACE_DAYS = 7;

const parseTime = (value) => {
    const ms = Date.parse(String(value ?? ''));
    return Number.isNaN(ms) ? null : ms;
};

/**
 * Delete pending sites whose window has lapsed.
 *
 * Safe to run twice: it deletes the held letters first and the manifest last,
 * so a crash partway leaves a still-expired manifest that the next run
 * finishes off. The reverse order would leave `.eml` files with nothing
 * describing them, which nothing would ever look at again.
 *
 * @param {object} input
 * @param {object} input.store
 * @param {function} [input.now]
 * @param {object} [input.log]
 * @param {boolean} [input.dryRun] report what would go, delete nothing
 */
export async function purgeExpired({ store, now = () => new Date(), log = console, dryRun = false }) {
    const at = now().getTime();
    const names = await store.listBlobs('pending', '');
    const manifests = names.filter((name) => name.endsWith('/claim.json'));

    const purged = [];
    const kept = [];

    for (const manifestName of manifests) {
        const slug = manifestName.slice(0, -'/claim.json'.length);

        let manifest;
        try {
            const blob = await store.readBlob('pending', manifestName);
            if (!blob) continue;
            manifest = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
        } catch (error) {
            // Unreadable means unjudgeable. Somebody has to look at this.
            log?.error?.('purge: unreadable manifest, keeping', { slug, error: error.message });
            kept.push({ slug, reason: 'unreadable' });
            continue;
        }

        // Letters still sitting under a claimed site mean promotion failed
        // partway, and those letters are unpublished originals with no copy
        // anywhere else. Deleting them would destroy both the data and the
        // evidence of the bug that stranded it.
        if (manifest.claimedAt) {
            log?.warn?.('purge: claimed site still holds letters, keeping', {
                slug,
                claimedAt: manifest.claimedAt
            });
            kept.push({ slug, reason: 'claimed' });
            continue;
        }

        const expiresAt = parseTime(manifest.expiresAt);
        if (expiresAt === null) {
            log?.error?.('purge: unreadable expiry, keeping', { slug, expiresAt: manifest.expiresAt });
            kept.push({ slug, reason: 'no-expiry' });
            continue;
        }

        if (at < expiresAt + GRACE_DAYS * DAY_MS) {
            kept.push({ slug, reason: 'live' });
            continue;
        }

        const held = names.filter((name) => name.startsWith(`${slug}/`) && name.endsWith('.eml'));

        // Logged before the deletion, not after, so the record survives a
        // crash in the middle of one. This is the only trace that will remain
        // of these letters once the soft-delete window closes.
        log?.warn?.('purge: removing expired pending site', {
            slug,
            letters: held.length,
            messageCount: manifest.messageCount ?? held.length,
            sender: manifest.sender ?? '',
            hasDirect: Boolean(manifest.hasDirect),
            expiresAt: manifest.expiresAt,
            emailsSent: manifest.claimEmailCount ?? 0,
            dryRun
        });

        if (!dryRun) {
            for (const name of held) await store.deleteBlob('pending', name);
            await store.deleteBlob('pending', manifestName);
        }

        purged.push({
            slug,
            letters: held.length,
            expiresAt: manifest.expiresAt,
            emailsSent: manifest.claimEmailCount ?? 0
        });
    }

    // Worth surfacing on its own: a site that expired having never been
    // emailed did not fail to be claimed, it failed to be *offered*. That is
    // our bug, not a family's silence, and it should not be buried inside a
    // routine cleanup count.
    const neverOffered = purged.filter((site) => site.emailsSent === 0);
    if (neverOffered.length) {
        log?.error?.('purge: expired without ever being offered', {
            slugs: neverOffered.map((site) => site.slug)
        });
    }

    return { scanned: manifests.length, purged, kept, dryRun };
}
