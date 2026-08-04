// What a lost race against another writer of posts.json looks like.
//
// Shared rather than duplicated because two copies of this predicate would be
// two chances to miss a status code, and the symptom of missing one is an
// exception escaping a retry loop that was written to absorb it.

export const CONFLICT_RETRIES = 8;

export const isConflict = (err) =>
    err?.statusCode === 412 ||
    err?.statusCode === 409 ||
    err?.code === 'ConditionNotMet' ||
    err?.code === 'BlobAlreadyExists';
