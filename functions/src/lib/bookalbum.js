// Pure layout planning for a letter's album pages and trailing photo rows.
//
// Driven entirely off recorded photo dimensions (`width`, `height`, `id`)
// rather than image bytes so the measuring pass and the printing pass
// reach the exact same pagination and row arrangements.

const INCH = 72;
const PAGE_HEIGHT = 11 * INCH;
const MARGIN_TOP = 66;
const MARGIN_BOTTOM = 72;
const COLUMN = 8.5 * INCH - 96 - 72;

// The album that faces a letter. `MIN_ROW` is the point at which a row of
// photographs stops being a row of photographs and becomes a strip of
// thumbnails; below it the album spills onto another page instead of
// shrinking further.
export const ALBUM_GAP = 10;
const ALBUM_MIN_ROW = 84;
export const ALBUM_MOST = 6;
const ALBUM_MIN_PHOTO_SHARE = 0.05;
const ALBUM_MIN_COLUMN_SHARE = 0.5;
const FEATURED_SIZE_TOLERANCE = 0.02;

// Four by three when nothing was recorded. Ingest measures every photograph it
// stores, so this is for the handful that predate it -- and a picture with no
// shape still has to be given one, because the alternative is a division by
// zero in the middle of a page.
export const aspectOf = (photo) =>
    photo?.width > 0 && photo?.height > 0 ? photo.width / photo.height : 4 / 3;

const portrait = (photo) => aspectOf(photo) < 0.9;
const albumRowAllowed = (photos) =>
    photos.length <= 3 || (photos.length === 4 && photos.every(portrait));

/**
 * Arrange photographs into rows that fill the width.
 *
 * The row height is what varies: pictures are added to a row until scaling
 * them to fill the column would push them below `target`, at which point the
 * row is closed and the next one starts. Every picture in a row shares a
 * height, every row is exactly the column wide, and nothing is cropped -- the
 * arrangement newspapers and photo albums have used for a century, for the
 * reason that it wastes no space and never distorts a face.
 *
 * Pure, and driven off the recorded dimensions rather than the files, because
 * the measuring pass has to reach the same arrangement without reading a
 * single byte.
 */
export function albumRows(photos, { target, width = COLUMN, gap = ALBUM_GAP }) {
    const rows = [];
    let row = [];
    let aspects = 0;

    for (const photo of photos) {
        if (row.length && !albumRowAllowed([...row, photo])) {
            rows.push({
                photos: row,
                height: (width - gap * (row.length - 1)) / aspects
            });
            row = [];
            aspects = 0;
        }

        row.push(photo);
        aspects += aspectOf(photo);

        const height = (width - gap * (row.length - 1)) / aspects;
        if (height <= target || row.length === 4) {
            rows.push({ photos: row, height });
            row = [];
            aspects = 0;
        }
    }

    // The last row is short, so it keeps the target height rather than being
    // stretched across the column. A single leftover picture blown up to the
    // full width is the classic tell of a grid that stopped thinking.
    if (row.length) {
        rows.push({
            photos: row,
            height: Math.min(target, (width - gap * (row.length - 1)) / aspects)
        });
    }

    return rows;
}

export const albumHeight = (rows) =>
    rows.reduce((total, row) => total + row.height, 0) + ALBUM_GAP * (rows.length - 1);

/**
 * The largest row height at which the whole album still fits one page.
 *
 * Searched rather than solved. The packing is a step function -- nudging the
 * target moves a picture between rows and the total height jumps -- so there
 * is no closed form to invert, and twenty-odd halvings settle it to well
 * under a point.
 */
export function albumTarget(photos, { height, width = COLUMN }) {
    let low = ALBUM_MIN_ROW;
    let high = height;

    if (albumHeight(albumRows(photos, { target: low, width })) > height) return low;

    for (let step = 0; step < 24; step += 1) {
        const mid = (low + high) / 2;
        if (albumHeight(albumRows(photos, { target: mid, width })) <= height) low = mid;
        else high = mid;
    }

    return low;
}

/**
 * Arrange one leaf's photographs to fill the page they have to themselves.
 */
const rowPartitions = (photos) => {
    const partitions = [];

    const visit = (at, rows) => {
        if (at === photos.length) {
            partitions.push(rows);
            return;
        }

        for (let end = at + 1; end <= Math.min(photos.length, at + 4); end += 1) {
            const row = photos.slice(at, end);
            if (albumRowAllowed(row)) visit(end, [...rows, row]);
        }
    };

    visit(0, []);
    return partitions;
};

const plannedRows = (bands, { height, width, gap }) => {
    const rows = bands.map((band) => {
        const aspects = band.reduce((sum, photo) => sum + aspectOf(photo), 0);
        return { photos: band, height: (width - gap * (band.length - 1)) / aspects };
    });

    const stack = rows.reduce((sum, row) => sum + row.height, 0);
    const scale = Math.min(1, (height - gap * (rows.length - 1)) / stack);
    return rows.map((row) => ({ photos: row.photos, height: row.height * scale }));
};

const photoAreas = (rows) =>
    rows.flatMap((row) =>
        row.photos.map((photo) => ({
            photo,
            area: row.height ** 2 * aspectOf(photo)
        }))
    );

const orientationOf = (photo) => {
    const aspect = aspectOf(photo);
    if (aspect > 1.1) return 'landscape';
    if (portrait(photo)) return 'portrait';
    return 'square';
};

const prominenceOf = (entries, featured) => {
    const ordinary = entries.filter((entry) => !featured.has(entry.photo.id));
    const ratios = entries
        .filter((entry) => featured.has(entry.photo.id))
        .map((entry) => {
            const comparable = ordinary.filter(
                (candidate) => orientationOf(candidate.photo) === orientationOf(entry.photo)
            );
            if (!comparable.length) return Number.POSITIVE_INFINITY;
            return entry.area / Math.max(...comparable.map((candidate) => candidate.area));
        });

    return ratios.length ? Math.min(...ratios) : 0;
};

const rowWidth = (row, gap) =>
    row.photos.reduce((sum, photo) => sum + row.height * aspectOf(photo), 0) +
    gap * (row.photos.length - 1);

const planMetrics = (rows, featured, { height, width, gap }) => {
    const entries = photoAreas(rows);
    const areas = entries.map((entry) => entry.area);
    const featuredAreas = entries
        .filter((entry) => featured.has(entry.photo.id))
        .map((entry) => entry.area);
    const prominence = prominenceOf(entries, featured);

    return {
        rows,
        area: areas.reduce((sum, value) => sum + value, 0),
        least: areas.length ? Math.min(...areas) : 0,
        featuredLeast: featuredAreas.length ? Math.min(...featuredAreas) : 0,
        prominence,
        prominent:
            featuredAreas.length > 0 &&
            prominence + FEATURED_SIZE_TOLERANCE + 0.0001 >= 1,
        legible:
            areas.length > 0 &&
            Math.min(...areas) + 0.01 >= width * height * ALBUM_MIN_PHOTO_SHARE,
        broad:
            rows.length > 0 &&
            Math.max(...rows.map((row) => rowWidth(row, gap))) + 0.01 >=
                width * ALBUM_MIN_COLUMN_SHARE
    };
};

const preferredPlans = (candidates, { preferLegibility }) => {
    if (!preferLegibility) return { candidates, legible: false };

    const broad = candidates.filter((candidate) => candidate.broad);
    const wideEnough = broad.length ? broad : candidates;
    const legible = wideEnough.filter((candidate) => candidate.legible);
    return { candidates: legible.length ? legible : wideEnough, legible: Boolean(legible.length) };
};

const chooseFeaturedPlan = (candidates, { preferLegibility }) => {
    const prominent = candidates.filter((candidate) => candidate.prominent);
    if (!prominent.length) {
        return candidates.sort(
            (a, b) =>
                b.prominence - a.prominence ||
                b.featuredLeast - a.featuredLeast ||
                b.area - a.area ||
                b.least - a.least
        )[0];
    }

    const preferred = preferredPlans(prominent, { preferLegibility });
    return preferred.candidates.sort(
        (a, b) =>
            (!preferred.legible ? b.least - a.least : 0) ||
            b.featuredLeast - a.featuredLeast ||
            b.area - a.area ||
            b.least - a.least
    )[0];
};

export function albumPlan(
    photos,
    {
        height,
        width = COLUMN,
        gap = ALBUM_GAP,
        featured = new Set(),
        preferLegibility = false
    }
) {
    if (!photos.length) return [];

    const selected = new Set(
        photos.filter((photo) => featured.has(photo.id)).map((photo) => photo.id)
    );
    const ordered = selected.size
        ? [
              ...photos.filter((photo) => selected.has(photo.id)),
              ...photos.filter((photo) => !selected.has(photo.id))
          ]
        : photos;
    const candidates = [];

    const partitions =
        selected.size && ordered.length <= ALBUM_MOST
            ? rowPartitions(ordered)
            : Array.from({ length: ordered.length }, (_, index) =>
                  albumSpread(ordered, { pages: index + 1 })
              ).filter((bands) => bands.every(albumRowAllowed));

    for (const bands of partitions) {
        const rows = plannedRows(bands, { height, width, gap });
        candidates.push(planMetrics(rows, selected, { height, width, gap }));
    }

    const mostArea = Math.max(...candidates.map((candidate) => candidate.area));
    if (selected.size) {
        return chooseFeaturedPlan(candidates, { preferLegibility }).rows;
    }

    const preferred = preferredPlans(candidates, { preferLegibility });
    const preferredArea = Math.max(...preferred.candidates.map((candidate) => candidate.area));

    return preferred.candidates
        .filter(
            (candidate) =>
                candidate.area >= (preferLegibility ? preferredArea : mostArea) * 0.95
        )
        .sort((a, b) => b.least - a.least)[0].rows;
}

/**
 * How many leaves to give a letter's album.
 */
export function albumPageCount(count) {
    if (count < 1) return 0;

    return Math.ceil(count / ALBUM_MOST);
}

export function endingPhotoCount(photoCount, { remaining, usable }) {
    if (photoCount < 1 || remaining < usable / 2) return 0;
    return Math.min(photoCount, 3);
}

export function endingAlbum(photos, { remaining, usable, page = 0, fillChapterBlank = false }) {
    let shared = endingPhotoCount(photos.length, { remaining, usable });
    let pages = albumPageCount(photos.length - shared);

    if (fillChapterBlank && photos.length > 1 && (page + pages) % 2 !== 0) {
        pages += 1;
        shared = Math.min(shared, photos.length - pages);
    }

    return {
        shared: photos.slice(0, shared),
        remaining: photos.slice(shared),
        pages
    };
}

export function prioritizedEndingAlbum(
    photos,
    { featured = new Set(), remaining, usable, page = 0, fillChapterBlank = false }
) {
    const ending = endingAlbum(photos, { remaining, usable, page, fillChapterBlank });
    const sharedCount = ending.shared.length;
    if (!featured.size || !sharedCount) return ending;

    const selected = photos.filter((photo) => featured.has(photo.id));
    const ordinary = photos.filter((photo) => !featured.has(photo.id));
    const shared = [...ordinary, ...selected].slice(0, sharedCount);
    const sharedIds = new Set(shared.map((photo) => photo.id));
    const rest = [...selected, ...ordinary].filter((photo) => !sharedIds.has(photo.id));

    return { ...ending, shared, remaining: rest };
}

/**
 * Deal the photographs out over that many pages, as evenly as they go.
 */
export function albumSpread(photos, { pages }) {
    const out = [];
    let taken = 0;

    for (let page = 1; page <= pages; page += 1) {
        const upTo = Math.round((photos.length * page) / pages);
        out.push(photos.slice(taken, upTo));
        taken = upTo;
    }

    return out;
}

const pageSizePlans = (count, pages) => {
    if (pages < 1) return [];

    const placeholders = Array.from({ length: count });
    const balanced = albumSpread(placeholders, { pages }).map((leaf) => leaf.length);
    const plans = [balanced];

    for (let index = 0; index < balanced.length - 1; index += 1) {
        if (balanced[index] > 2 && balanced[index + 1] < ALBUM_MOST) {
            const shifted = [...balanced];
            shifted[index] -= 1;
            shifted[index + 1] += 1;
            plans.push(shifted);
        }

        if (balanced[index + 1] > 2 && balanced[index] < ALBUM_MOST) {
            const shifted = [...balanced];
            shifted[index] += 1;
            shifted[index + 1] -= 1;
            plans.push(shifted);
        }
    }

    return plans;
};

const leavesForSizes = (photos, sizes, { height, featured }) => {
    const leaves = [];
    let at = 0;

    for (const size of sizes) {
        const leaf = photos.slice(at, at + size);
        const rows = albumPlan(leaf, { height, featured, preferLegibility: true });
        leaves.push({ photos: leaf, rows });
        at += size;
    }

    return leaves;
};

const dealtLeaves = (photos, sizes, { height, featured, matchOrientation = false }) => {
    const leaves = sizes.map(() => []);
    const selected = photos.filter((photo) => featured.has(photo.id));
    const ordinary = photos.filter((photo) => !featured.has(photo.id));

    const available = () =>
        leaves
            .map((leaf, index) => ({ index, fullness: leaf.length / sizes[index] }))
            .filter(({ index }) => leaves[index].length < sizes[index]);
    const place = (photo, choices = available()) => {
        const [{ index }] = choices.sort(
            (a, b) => a.fullness - b.fullness || a.index - b.index
        );
        leaves[index].push(photo);
    };

    for (const photo of selected) place(photo);
    for (const photo of ordinary) {
        const choices = available();
        const comparable = matchOrientation
            ? choices.filter(({ index }) =>
                  leaves[index].some(
                      (candidate) =>
                          featured.has(candidate.id) &&
                          orientationOf(candidate) === orientationOf(photo)
                  )
              )
            : [];
        place(photo, comparable.length ? comparable : choices);
    }

    return leaves.map((leaf) => ({
        photos: leaf,
        rows: albumPlan(leaf, { height, featured, preferLegibility: true })
    }));
};

const spreadMetrics = (leaves, featured, { height, width = COLUMN, gap = ALBUM_GAP }) => {
    const entries = leaves.flatMap((leaf) => photoAreas(leaf.rows));
    const areas = entries.map((entry) => entry.area);
    const featuredAreas = entries
        .filter((entry) => featured.has(entry.photo.id))
        .map((entry) => entry.area);
    const prominence = prominenceOf(entries, featured);
    const counts = leaves.map((leaf) => leaf.photos.length);

    return {
        leaves,
        area: areas.reduce((sum, value) => sum + value, 0),
        least: areas.length ? Math.min(...areas) : 0,
        featuredLeast: featuredAreas.length ? Math.min(...featuredAreas) : 0,
        prominence,
        prominent:
            featuredAreas.length > 0 &&
            prominence + FEATURED_SIZE_TOLERANCE + 0.0001 >= 1,
        legible:
            areas.length > 0 &&
            Math.min(...areas) + 0.01 >= width * height * ALBUM_MIN_PHOTO_SHARE,
        broad: leaves.every(
            (leaf) =>
                leaf.rows.length > 0 &&
                Math.max(...leaf.rows.map((row) => rowWidth(row, gap))) + 0.01 >=
                    width * ALBUM_MIN_COLUMN_SHARE
        ),
        featuredLeaves: leaves.filter((leaf) =>
            leaf.photos.some((photo) => featured.has(photo.id))
        ).length,
        imbalance: Math.max(...counts) - Math.min(...counts)
    };
};

/**
 * Arrange an album inside its existing page budget.
 */
export function albumLeaves(
    photos,
    {
        pages = albumPageCount(photos.length),
        height = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM,
        featured = new Set()
    } = {}
) {
    if (!photos.length || pages < 1) return [];

    const selected = new Set(
        photos.filter((photo) => featured.has(photo.id)).map((photo) => photo.id)
    );
    if (!selected.size) {
        return albumSpread(photos, { pages }).map((leaf) => ({
            photos: leaf,
            rows: albumPlan(leaf, { height, preferLegibility: true })
        }));
    }

    const ordered = [
        ...photos.filter((photo) => selected.has(photo.id)),
        ...photos.filter((photo) => !selected.has(photo.id))
    ];
    const byAspect = [...ordered].sort((a, b) => aspectOf(b) - aspectOf(a));
    const candidates = pageSizePlans(ordered.length, pages).flatMap((sizes) => [
        spreadMetrics(
            leavesForSizes(ordered, sizes, { height, featured: selected }),
            selected,
            { height }
        ),
        spreadMetrics(
            dealtLeaves(ordered, sizes, { height, featured: selected }),
            selected,
            { height }
        ),
        spreadMetrics(
            dealtLeaves(ordered, sizes, {
                height,
                featured: selected,
                matchOrientation: true
            }),
            selected,
            { height }
        ),
        spreadMetrics(
            leavesForSizes(byAspect, sizes, { height, featured: selected }),
            selected,
            { height }
        )
    ]);
    const prominent = candidates.filter((candidate) => candidate.prominent);
    const eligible = prominent.length ? prominent : candidates;
    const mostFeaturedLeaves = Math.max(
        ...eligible.map((candidate) => candidate.featuredLeaves)
    );
    const distributed = eligible.filter(
        (candidate) => candidate.featuredLeaves === mostFeaturedLeaves
    );
    const broad = distributed.filter((candidate) => candidate.broad);
    const wideEnough = broad.length ? broad : distributed;
    const legible = wideEnough.filter((candidate) => candidate.legible);
    const pool = legible.length ? legible : wideEnough;

    return pool.sort(
        (a, b) =>
            (!legible.length ? b.least - a.least : 0) ||
            (prominent.length
                ? b.featuredLeast - a.featuredLeast
                : b.prominence - a.prominence) ||
            (prominent.length ? b.area - a.area : b.featuredLeast - a.featuredLeast) ||
            (!prominent.length ? b.area - a.area : 0) ||
            b.least - a.least ||
            a.imbalance - b.imbalance
    )[0].leaves;
}
