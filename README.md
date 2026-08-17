# Pday Letters

An automatic weekly-letters archive for LDS missionaries.

A missionary BCCs one shared address on their weekly email home — or a family member forwards it after the fact. Either way, the letter and its photos are published to that missionary's private, access-controlled letters site, where everything is searchable. When the mission ends, the whole archive can be downloaded as a self-contained offline copy or printed as a hardcover book.

- [docs/pitch.md](docs/pitch.md) — what the service does, in plain language.
- [docs/plan.md](docs/plan.md) — full technical design.

**Status:** Phase 0 complete. The Azure resources and mail routing are deployed, but the ingest Worker is not written yet, so the service is not accepting mail.

**Worker SAS expires 2027-08-01.** Both stored access policies — `worker-write` on the `inbox` container and `worker-add` on the `ingest` queue — end on that date. Re-mint with `infra/mint-worker-sas.ps1` before then; an expired SAS turns every inbound letter into an SMTP retry loop rather than a visible error.
