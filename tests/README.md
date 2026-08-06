# Fixtures

Real captures, one per client and route, each with an `expected.json` describing
what extraction should make of it.

These are scrubbed, and **scrubbing breaks DKIM** — it rewrites headers and
re-encodes MIME parts, both of which a signature covers. Never conclude anything
about DKIM from a file in this directory.

Unscrubbed copies live in the private repo. Tests resolve
`MISSION_JOURNAL_PRIVATE_FIXTURES`, falling back to
`../mission-journal-private/fixtures`, and skip when it is absent. See
`functions/tests/dkim.test.js`.
