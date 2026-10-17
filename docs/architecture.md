# Architecture

What exists in Azure and Cloudflare, and how the pieces connect. Every "why" lives in [plan.md](plan.md) — this file is the map, not the reasoning.

---

## System overview

Mail flows in from the left; pages and print go out to the right.

```mermaid
flowchart LR
    missionary([Missionary]) -->|"BCC or forward"| cf
    family(["Family & friends"]) -->|forward| cf

    subgraph cloudflare["Cloudflare"]
        direction TB
        cf["Email Routing<br/>MX on pdayletters.com"]
        worker["Email Worker<br/>mj-ingest"]
        cf -->|in-SMTP| worker
    end

    subgraph azure["Azure &mdash; mission-journal<br/>resources: westus2 · Static Web App: centralus"]
        direction TB
        swa["Static Web App<br/>mj-swa-*<br/>Standard"]
        fn["Function App<br/>mj-fn-*<br/>Flex Consumption"]
        st[("Storage<br/>mjst*<br/>GRS")]
        kv["Key Vault<br/>mj-kv-*"]
        ai["App Insights<br/>mj-ai-*<br/>mj-log-*"]

        swa -->|"/api/*"| fn
        fn --> st
        fn --> kv
        fn --> ai
        swa --> kv
    end

    worker -->|"scoped SAS: blob write + queue add"| st
    swa <-->|"Google or Microsoft sign-in"| reader(["Reader in a browser"])
    fn -->|REST| mail["Cloudflare Email Service<br/>outbound mail"]
    fn -->|REST| peecho["Peecho<br/>print fulfilment"]
```

Details: [High-level architecture](plan.md#high-level-architecture) · [Azure resource plan](plan.md#azure-resource-plan) · [External constraints](plan.md#external-constraints)

---

## Ingest pipeline

```mermaid
flowchart TD
    cf["Cloudflare Email Routing"] --> w["Email Worker"]
    w -->|"raw bytes, no parsing"| inbox["blob: inbox/{ulid}.raw"]
    w -->|"ulid"| q1[["queue: ingest"]]

    q1 --> ing["Function: ingest"]
    ing -->|"DKIM / ARC verify, classify, route by sender"| decide{"Slug claimed?"}
    ing -->|"acknowledgements, claim offers, nudges"| mail["Cloudflare Email Service"]
    decide -->|"yes"| raw["blob: raw/{slug}/{msgId}/"]
    decide -->|"no"| pending["blob: pending/{slug}/"]
    decide -->|"refused"| rej[("table: rejections")]

    raw --> q2[["queue: render"]]
    q2 --> ren["Function: render"]
    ren -->|"sanitize HTML, WebP renditions"| rendered["blob: rendered/{slug}/"]

    digest["Timer: digest"] -->|"read due digest-settings rows"| users[("table: users")]
    digest --> rendered
    digest -->|"summary mail"| mail
```

Details: [Email ingestion](plan.md#email-ingestion) · [Cloudflare Email Routing](plan.md#email-ingestion--cloudflare-email-routing) · [Missionary routing](plan.md#missionary-routing) · [Content sanitization](plan.md#content-sanitization) · [Photo handling](plan.md#photo-handling)

---

## Read path

Nothing in storage is public. Every byte a browser sees passes an ACL check first.

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Static Web App
    participant F as Function App
    participant BL as Blob storage
    participant T as Tables

    B->>S: GET /elder.smith
    S-->>B: static shell + auth cookie
    B->>S: GET /api/content/{slug}/posts.json
    S->>F: proxy + x-ms-client-principal
    F->>BL: read config/{slug}/acl.json
    BL-->>F: roles
    Note over F: no role → 404, never 403
    F->>T: upsert visits row
    F->>BL: read rendered/{slug}/posts.json
    F-->>B: sanitized JSON, ETag, no-store
    B->>S: GET /api/photo/{slug}/{id}/large.webp
    S->>F: proxy
    F-->>B: streamed bytes, private cache
```

Details: [Private content delivery](plan.md#private-content-delivery) · [Access control](plan.md#access-control) · [Signing in and getting around](plan.md#signing-in-and-getting-around) · [Service operators](plan.md#service-operators)

---

## Blob containers

All private, no public access. One GRS account holds everything durable.

```mermaid
flowchart TB
    subgraph auth[Authoritative — losing it loses letters]
        raw["raw/{slug}/{msgId}/<br/>message.eml · attachments/ · metadata.json"]
        config["config/{slug}/<br/>profile.json · acl.json · cover.webp<br/>book-sections.json · claim state"]
        pending["pending/{slug}/<br/>claim.json + unclaimed letters"]
    end

    subgraph derived[Derived — rebuildable from raw/]
        rendered["rendered/{slug}/<br/>posts.json · photos/{id}/large.webp · thumb.webp"]
        books["books/{slug}/{id}/<br/>book.pdf · proof.pdf · status.json · manifest.json<br/>cover.jpg · order.json"]
        exports["exports/<br/>staged offline archives"]
    end

    subgraph transient[Landing zone]
        inbox["inbox/{ulid}.raw"]
    end

    inbox -->|ingest| raw
    inbox -->|ingest| pending
    pending -->|claim| raw
    raw -->|render| rendered
    rendered --> books
    rendered --> exports
```

| Container | Lifecycle |
|---|---|
| `inbox` | deleted after 30 days, versions and snapshots too |
| `exports` | deleted after 7 days |
| `raw` | moved to Cold after 30 days |
| `raw`, `rendered`, `books` | superseded blob versions expire after 30 days |

`raw/` is never served to anyone and is not in the offline export — it exists for reprocessing and for authorship evidence.

Details: [Storage layout](plan.md#storage-layout) · [Data model](plan.md#data-model-postsjson-entry) · [Journal Publish](plan.md#journal-publish) · [Post-mission archive](plan.md#post-mission-archive)

---

## `config/{slug}/acl.json`

The source of truth for who may read a site. Checked on **every** content request; no table may override it.

```mermaid
flowchart LR
    acl["acl.json"] --> owner["role: owner<br/>edit, invite, delete, publish"]
    acl --> reader["role: reader<br/>read only"]
    acl --> flag["verifiedMissionary<br/>the one owner nobody can remove"]
    acl -.dual-written.-> mem[(table: memberships)]
    mem -.->|reverse lookup only| menu["archive picker menu"]
```

Details: [Access control](plan.md#access-control) · [Ownership and the 60-day window](plan.md#ownership-and-the-60-day-window)

---

## Tables

Fourteen physical tables share the same storage account.

<!-- Keep Mermaid entity rows limited to stored properties. Put authority, access patterns, and lifecycle in prose. -->

### User profiles

The `users` table holds two record types in each email partition. A `profile` row contains presentation-only name data copied from the sign-in provider. Verified email and `acl.json`, not these names, remain the identity and authorization inputs.

```mermaid
erDiagram
    users_profile {
        string PartitionKey "lowercased email"
        string RowKey "profile"
        string displayName
        string givenName "optional"
        string familyName "optional"
        string nameProvider
        string nameUpdatedAt "ISO timestamp"
    }
```

### Digest settings

The second `users` row type is `digest-settings`. Most reads are point reads by email; the daily digest timer scans the table and selects only rows with this `RowKey`.

```mermaid
erDiagram
    users_digest_settings {
        string PartitionKey "lowercased email"
        string RowKey "digest-settings"
        string digestFrequency "off, weekly, or monthly"
        int digestWeekday "0 through 6"
        int digestWeek "1 through 4"
        string digestAt "ISO cycle cursor"
        string digestScheduleAt "optional ISO timestamp"
        string createdAt "optional ISO timestamp"
        int promptVisits
        string promptVisitedAt "optional ISO timestamp"
        string promptDismissedAt "optional ISO timestamp"
    }
```

### Provider identity

This is a repairable index from a stable provider identity to the provider's current email address.

```mermaid
erDiagram
    identities {
        string PartitionKey "identity"
        string RowKey "sha256 of provider and userId"
        string email "lowercased current email"
        string at "ISO timestamp"
    }
```

### Memberships and emailed invitations

```mermaid
erDiagram
    memberships {
        string PartitionKey "lowercased email"
        string RowKey "slug"
        string role "owner or reader"
        string addedAt "ISO timestamp"
    }
    invites {
        string PartitionKey "slug"
        string RowKey "hash of invitation token"
        string email "lowercased invitee"
        string role "owner or reader"
        string invitedBy "lowercased email"
        string createdAt "ISO timestamp"
        string expiresAt "ISO timestamp"
        string acceptedAt "optional ISO timestamp"
        string acceptedBy "optional lowercased email"
        string revokedAt "optional ISO timestamp"
        string supersededBy "optional token hash"
    }
```

`memberships` is a derived reverse index from `acl.json` and never grants access. Invitation rows are retained as tombstones after acceptance or revocation so a spent token cannot become valid again.

### Quick Join

```mermaid
erDiagram
    qrInvites {
        string PartitionKey "slug"
        string RowKey "active"
        string sessionId
        string invitedBy "lowercased owner email"
        string createdAt "ISO timestamp"
        string expiresAt "ISO timestamp"
        string closedAt "empty or ISO timestamp"
    }
    qrRedemptions {
        string PartitionKey "slug:sessionId"
        string RowKey "ticket-{token hash}"
        string acceptedBy "lowercased email"
        string acceptedAt "ISO timestamp"
        string completedAt "empty or ISO timestamp"
    }
```

The displayed QR code is multi-use: every scan exchanges it for a new random ticket, so several people can scan the same code and join independently. A `qrRedemptions` row binds one browser's ticket to the first signed-in account that accepts it, lets that account retry safely, and prevents a copied ticket from adding a different account. After the owner closes Quick Join, the server rejects any later exchange attempt made from an old screenshot or a camera view still holding the code. Tickets issued before closure retain 20 seconds to finish sign-in.

### Archive metadata and reminders

```mermaid
erDiagram
    sites {
        string PartitionKey "slug"
        string RowKey "activity"
        string missionaryDisplayName
        string missionName
        string missionStartDate "YYYY-MM-DD or empty"
        string missionReturnDate "YYYY-MM-DD or empty"
        string photoAlbumUrls "JSON string array"
        string lastPostAt "letter date"
        string lastReceivedAt "arrival timestamp"
    }
    nudges {
        string PartitionKey "lowercased email"
        string RowKey "slug:kind or dated ack/reject key"
        string sentAt "ISO timestamp"
        string author "optional missionary email"
    }
```

`nudges` rows are send-once locks. Most are permanent per recipient/archive/kind; acknowledgement and rejection keys include a UTC date.

### Mail consent and delivery

```mermaid
erDiagram
    optouts {
        string PartitionKey "optout"
        string RowKey "sha256 of email"
        string email "lowercased email"
        string at "ISO timestamp"
        string slug "archive that prompted opt-out"
    }
    deliveries {
        string PartitionKey "delivery"
        string RowKey "sha256 of email"
        string email "lowercased email"
        string status
        string at "ISO timestamp"
        string slug "most recent related archive"
    }
```

`optouts` is authoritative consent state. `deliveries` is a replaceable snapshot of the most recent Cloudflare delivery outcome.

### Intake guards

```mermaid
erDiagram
    arrivals {
        string PartitionKey "slug:YYYY-MM-DD"
        string RowKey "message ULID"
    }
    rejections {
        string PartitionKey "slug"
        string RowKey "message ULID"
        string at "ISO timestamp"
        string sender
        string author
        string subject
        string reason
        string source
        string forgetAfter "ISO timestamp"
    }
```

`arrivals` enforces the daily intake cap and is swept after 30 days. A `rejections` row is the only retained trace of a refused first letter and remains until `forgetAfter`.

### Activity and deletion lifecycle

```mermaid
erDiagram
    visits {
        string PartitionKey "archive slug"
        string RowKey "sha256 of lowercased email"
        string lastAccessAt "ISO timestamp"
    }
    deletions {
        string PartitionKey "slug"
        string RowKey "record"
        string deletedAt "ISO timestamp"
        string deletedBy "lowercased email"
        string reason
        string purgeAfter "ISO timestamp"
    }
```

`visits` records the latest access for each person and archive. The email hash is a fixed Azure-safe key and limits casual disclosure; it is pseudonymous rather than anonymous because a known address can be hashed and matched. `deletions` is authoritative for the 30-day restoration and purge window.

### How the two `users` row types are written and read

```mermaid
flowchart LR
    auth["Static Web Apps /.auth/me<br/>provider name claims"] --> browser["user-profile.js in the browser"]
    browser -->|"PUT /api/profile<br/>name fields only"| profileApi["Function: user-profile-write"]
    edge["Static Web Apps proxy<br/>verified email + provider"] --> profileApi
    profileApi --> profile[("users<br/>PK: email · RK: profile")]
    profile -.->|"names in People, invitations,<br/>account and operator displays"| presentation["presentation surfaces"]

    preferences["preferences API<br/>and digest prompt"] --> digest[("users<br/>PK: email · RK: digest-settings<br/>frequency · schedule · cycle cursor · prompt state")]
    digestTimer["daily digest timer"] -->|"scan due rows"| digest
```

Details: [Storage layout](plan.md#storage-layout) · [Notification preferences](plan.md#notification-preferences) · [New-letter notifications](plan.md#new-letter-notifications) · [Onboarding and auto-provisioning](plan.md#onboarding-and-auto-provisioning)

---

## Queues and scheduled work

```mermaid
flowchart LR
    subgraph queues[Storage queues]
        ingest[[ingest]] --> ingestFn[ingest]
        render[[render]] --> renderFn[render]
        book[[book]] --> bookFn[book assembly]
    end
```

| Timer | UTC | What it does |
|---|---|---|
| `purge` | 03:15 | erase expired `pending/` sites |
| `remind` | 03:45 | tapering claim re-invitations |
| `sweep` | 03:45 | drop finished `arrivals` rows and normalize legacy daily `visits` rows |
| `erase` | 04:15 | erase archives past the 30-day deletion window |
| `digest` | 13:15 | new-letter digests |

Book assembly is its own queue: a render is one letter and takes a second, a book is a whole archive and takes minutes.

Details: [New-letter notifications](plan.md#new-letter-notifications) · [Journal Publish](plan.md#journal-publish) · [Onboarding and auto-provisioning](plan.md#onboarding-and-auto-provisioning)

---

## HTTP API

All routes are behind the Static Web App at `/api/*` and authorize inside the handler.

```mermaid
flowchart TB
    subgraph read[Reading]
        r1["content/{slug}/posts.json"]
        r2["photo/{slug}/{id}/{size}.webp"]
        r3["download/{slug}/letters.zip"]
    end
    subgraph account["Signed-in account"]
        u1["memberships"]
        u2["preferences · preferences/prompt"]
        u3["profile — provider-supplied user name"]
    end
    subgraph own[Owners]
        o1["posts/{slug}/{postId} — edit, hide, restore, photos"]
        o2["members/{slug} — invite, resend, promote, remove, Quick Join"]
        o3["profile/{slug} · site/{slug}"]
        o4["book/{slug} — cover, sections, proof, publish"]
        o5["print/{slug}/{id} — Peecho checkout and files"]
        o6["photos/google/* — album import"]
    end
    subgraph anon[Token-bearing, no sign-in]
        a1["claim/describe · claim/redeem · claim/resend"]
        a2["invite/describe · invite/accept"]
        a3["qr-invite/exchange · qr-invite/accept"]
        a4["optout/describe · optout"]
        a5["relay/describe · relay"]
        a6["peecho/placed · peecho/status — signed webhooks"]
    end
    subgraph op["Operators — manage/*, 404 to everyone else"]
        p1["manage/deletions · manage/last-received · manage/summary"]
        p2["manage/stats · manage/pending"]
        p3["manage/rejections/*"]
    end
```

`admin/` is reserved by the Functions host, which is why operator routes are `manage/`.

Details: [Service operators](plan.md#service-operators) · [Editing and hiding posts](plan.md#editing-and-hiding-posts) · [Moderation / quarantine](plan.md#moderation--quarantine) · [The photo album](plan.md#the-photo-album) · [Adding pictures from Google Photos](plan.md#adding-pictures-from-google-photos)

---

## Identity and secrets

No storage connection string and no Azure credential is stored in this repository.

```mermaid
flowchart LR
    gh[GitHub Actions] -->|OIDC, federated| depId[UAMI: deploy]
    depId --> rg[Resource group]

    fnId[Function App<br/>system-assigned MI] --> stBlob[Blob: Data Contributor]
    fnId --> stQueue[Queue: Data Contributor]
    fnId --> stTable[Table: Data Contributor]
    fnId --> kvSecrets[Key Vault: Secrets User]

    swaId[Static Web App<br/>system-assigned MI] --> kvSecrets

    purgeId[UAMI: purge] --> stOwner[Blob: Data Owner]

    worker[Cloudflare Worker] -->|stored access policy SAS<br/>expires 2027-08-01| inboxOnly["inbox container — write only<br/>ingest queue — add only"]
```

Key Vault holds the auth client secrets, the claim-token signing key, the Cloudflare API token, and the Peecho keys. A second storage account (`mjdep*`, LRS, Hot) holds only the deployment package — separated so versioning and GRS apply to letters and not to a zip republished daily.

Details: [Azure resource plan](plan.md#azure-resource-plan) · [External constraints](plan.md#external-constraints)

---

## Observability

App Insights is workspace-based on `mj-log-*` with a **1 GB/day ingest cap** and a scheduled-query alert on approach. Key Vault secret expiry raises Event Grid events to an action group. The Cloudflare Worker is the one component whose telemetry does not reach App Insights — Workers Logs is its only record.
