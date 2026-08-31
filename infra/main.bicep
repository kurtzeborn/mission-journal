targetScope = 'resourceGroup'

@description('Location for most resources. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Location for the Static Web App. SWA is only available in a subset of regions.')
@allowed([
  'westus2'
  'centralus'
  'eastus2'
  'westeurope'
  'eastasia'
])
param staticWebAppLocation string = 'centralus'

@description('Short prefix used in resource names.')
@minLength(2)
@maxLength(6)
param namePrefix string = 'mj'

@description('''
Static Web App plan. Standard only, from Phase 3 onward: linking a Function App
as the /api backend requires it, and so does the custom Google provider. The
Free branch is removed rather than left unused -- it produced a template that
deployed successfully and then could not serve the API at all, which is a worse
failure than refusing the value up front.
''')
@allowed([
  'Standard'
])
param staticWebAppSku string = 'Standard'

@description('Comma-separated domains this service accepts inbound mail on. Recipient-side, not sender-side.')
param acceptedIngestDomains string

@description('Comma-separated domains treated as genuine missionary mail.')
param missionaryDomains string = 'missionary.org'

@description('The authserv-id of our own inbound mail provider, whose Authentication-Results is the only one trusted.')
param authservId string = 'mx.cloudflare.net'

@description('Days before inbox blobs are deleted by lifecycle policy.')
param inboxRetentionDays int = 30

@description('Days before a staged export archive is deleted by lifecycle policy.')
param exportRetentionDays int = 7

@description('Days before an original message in raw/ is moved to the Cold tier.')
param rawColdAfterDays int = 30

@description('Days before a superseded version of an archive blob is deleted by lifecycle policy.')
param archiveVersionRetentionDays int = 30

@description('GB of telemetry the workspace will accept in a day before it stops ingesting.')
param workspaceDailyQuotaGb int = 1

@description('''
Where operational alerts are mailed. Empty means no action group and no Event
Grid subscription are created at all, which is the right default for a scratch
deployment -- an alert nobody reads is worse than no alert, because it looks
like coverage.

**This address is deliberately reached by Azure Monitor and not by our own
mailer.** Every other message this service sends goes out through Cloudflare,
using the API token in `cloudflare-api-token` -- which is one of the very
secrets being watched here. Wiring the near-expiry warning through the mailer
would mean the alert that the sending credential is about to expire is itself
sent with the sending credential, and the first alert to matter would be the
first one that could not be delivered. Monitor's email path shares nothing with
the system it is reporting on.
''')
param alertEmail string = ''

// Client IDs are public identifiers -- they travel in every authorization
// request and appear in the browser's address bar -- so they belong in source
// where a reader can see which registrations the site actually trusts. The
// matching secrets do not: those live in Key Vault and are referenced below.
//
// WARNING for anyone rebuilding from this file: the Entra registration also
// needs an implicit ID-token grant, and that property lives in Graph, not ARM,
// so nothing here can create or restore it. Deploying this template against a
// fresh registration produces a site where Google sign-in works and Microsoft
// sign-in dies at /.auth/login/aad/callback with no session. Run:
//
//   az ad app update --id <appId> --enable-id-token-issuance true
//
@description('Application (client) ID of the Entra app registration used for Microsoft sign-in.')
param aadClientId string = '3d78e421-0373-4026-be5d-909bc07d455a'

@description('OAuth client ID of the Google Cloud client used for Google sign-in.')
param googleClientId string = '708556118044-3fmn941npk65g8pbkivsg15l0bs4o4ap.apps.googleusercontent.com'

@description('Key Vault secret names holding the two OAuth client secrets.')
param aadClientSecretName string = 'aad-client-secret'
param googleClientSecretName string = 'google-client-secret'

@description('Key Vault secret holding the HMAC key that signs claim links.')
param claimTokenKeyName string = 'claim-token-key'

@description('Cloudflare account that owns the sending domain, and the Key Vault secret holding its API token.')
param cloudflareAccountId string = ''
param cloudflareTokenName string = 'cloudflare-api-token'

@description('''
Comma-separated addresses the service may send to. Empty means nobody, and
that is the default on purpose: every recipient in this system is computed
from headers a stranger wrote, so the failure mode of a bug here is mailing
a stranger. `*` disables the gate and has to be typed deliberately.
''')
param mailAllowlist string = ''

@description('''
The origin claim links point at. Deliberately a parameter rather than the
Static Web App's generated hostname: a link in somebody's inbox outlives the
deployment that sent it, and the custom domain is the only name a recipient
will recognise as the one they were told about.
''')
param publicBaseUrl string = 'https://pdayletters.com'

@description('''
The printer. `peechoBase` decides whether an order becomes a real book: their
test environment is a separate account whose orders are never printed and
never charged. The code's own default is that test environment, so a developer
who runs this service with no configuration cannot post a book to anybody; this
file is production infrastructure, so it names production instead, and does it
here where the choice is reviewable rather than in a script somebody ran once.

`peechoOfferingId` pins the exact product -- hardcover, Letter, 2.5mm board,
gloss coated 200gsm -- so the buyer is shown their own book instead of being
asked to choose a product category first. Empty is allowed and means they
choose, which is worse but not broken.

Both keys are Key Vault references, created out of band by
`provision-peecho.ps1`. An environment where they do not resolve has no
printer, tells the book page so, and offers nothing for sale.
''')
param peechoBase string = 'https://www.peecho.com'
param peechoOfferingId string = '7230432'
param peechoApiKeyName string = 'peecho-api-key'
// Named for what it holds rather than what Peecho calls it: a parameter with
// `secret` in its name is linted as though it were the secret itself.
param peechoSigningKeyName string = 'peecho-secret-key'

@description('''
Comma-separated addresses that may administer any archive in the service.
Empty means nobody, which is the default and what every environment but
production runs with.

This is configuration rather than data on purpose. A privilege this broad must
not be grantable through the interface it grants: were the list in a blob or a
table, one compromised operator account could quietly add a second and make the
escalation permanent. As a setting it takes Azure control-plane access to
change, which is a separate credential and separately recorded in the Activity
Log. There is deliberately no UI for editing it.
''')
param operatorEmails string = ''

@description('''
GitHub's `sub_claim_prefix` for this repository, which the federated credential
below must match exactly. **It is not `repo:owner/name`**, despite nearly every
example showing that: GitHub's current default subject embeds the numeric owner
and repository IDs, so a credential written the documented way fails with
AADSTS700213 and an error naming a subject nobody wrote down. The IDs are the
point -- they survive a rename, and they cannot be inherited by whoever
registers the name after a repository is deleted.

Read the live value rather than assembling it:

  gh api repos/kurtzeborn/mission-journal/actions/oidc/customization/sub
''')
param githubSubjectPrefix string = 'repo:kurtzeborn@22382549/mission-journal@1311226429'

var suffix = uniqueString(resourceGroup().id)
var storageName = toLower('${namePrefix}st${suffix}')
var deployStorageName = toLower('${namePrefix}dep${suffix}')
var keyVaultName = toLower('${namePrefix}-kv-${suffix}')
var workspaceName = '${namePrefix}-log-${suffix}'
var appInsightsName = '${namePrefix}-ai-${suffix}'
var staticWebAppName = '${namePrefix}-swa-${suffix}'
var workerPlanName = '${namePrefix}-plan-${suffix}'
var workerAppName = '${namePrefix}-fn-${suffix}'

var storageBlobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var storageQueueDataContributor = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var storageTableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

// The containers the Functions host keeps for itself on the archive account:
// the lease blobs it coordinates with, and its own key material. Declared here
// only so that a role assignment can be scoped to them -- see workerHostRoles.
// The host creates them on its own if they are missing. The deployment package
// is deliberately not among them; see deployStorage.
var hostContainerNames = [
  'azure-webjobs-hosts'
  'azure-webjobs-secrets'
]

// ---------------------------------------------------------------------------
// Storage — the durable archive. GRS because raw/ is, for many families, the
// only surviving copy of these letters.
// ---------------------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_GRS'
  }
  kind: 'StorageV2'
  properties: {
    // Hot despite this being an archive. Cool prices bytes at rest 40% lower
    // but charges 2.5x for reads and adds a per-GB retrieval fee, and reads
    // are two thirds of the bill here -- the Functions host alone re-reads its
    // 55 MB package on every cold start. Cool only wins past roughly 55 GB.
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 30
      // Without this, a soft-deleted version cannot be removed by any means —
      // the service returns 403 and the data simply ages out after `days`.
      // That is incompatible with promising a family their letters are deleted
      // when they ask. See the deletion notes under "Owner-only actions" in
      // docs/plan.md for the trade-off this accepts.
      //
      // ON PURPOSE DURING DEVELOPMENT, AND REVISITED IN PHASE 9. It exists now
      // so infra/reset-slug.ps1 can wipe a slug between test runs. Once the
      // deletion timer has its own custom role, weigh turning this back off:
      // it is the flag that stops soft delete from being an absolute backstop
      // against a compromised credential mass-deleting the archive.
      allowPermanentDelete: true
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

// `inbox` is a separate container, not a prefix inside `raw`. A blob service
// SAS can only be scoped to a container or a single blob — prefix scoping
// needs a hierarchical namespace. Keeping the landing zone separate means the
// Worker's credential cannot touch the permanent archive even if it leaks.
//
// `exports` holds staged download archives, which are derived data: every byte
// in one can be rebuilt from `rendered/`. Separate so that losing it costs
// nothing, and so a lifecycle rule can be aimed at it without any chance of
// catching the originals.
var containerNames = [
  'inbox'
  'raw'
  'rendered'
  'config'
  'exports'
  // Letters for a slug nobody has claimed yet. Held, never rendered, and
  // never served -- a pending site has no ACL, so there is nobody it could
  // be served to. Promotion into raw/ arrives with the claim flow.
  'pending'
  // Finished books, and the one derived container with no expiry rule on it.
  // Once a book has been ordered the printer may fetch it again to make a
  // reprint, so a lifecycle rule aimed here would break an order months
  // after anybody remembered making it. They are small in number -- one per
  // time an owner presses publish -- and large individually, which is the
  // opposite shape from `exports` and the reason it is a separate container
  // rather than a prefix inside one.
  'books'
]

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for name in containerNames: {
    parent: blobService
    name: name
    properties: {
      publicAccess: 'None'
    }
  }
]

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// Both of these are derived indexes, never the authority. `acl.json` remains
// the source of truth for who may read a site, and the content API keeps
// checking it on every request; `memberships` exists only to answer the
// reverse question -- which sites does this address belong to -- which a blob
// layout cannot answer without scanning every ACL in the account.
var tableNames = [
  'memberships'
  'users'
  'sites'
  // Not an index of anything: a record of who has already been told once that
  // their forward did not come through, and which of the two reasons it was.
  // It exists so that advice cannot be sent twice.
  'nudges'
  // Also not an index, and the only table that is authoritative: an unaccepted
  // invitation exists nowhere else. It is kept out of `acl.json` deliberately,
  // so that nothing `resolveRole` reads can confuse an offer of access with
  // access.
  'invites'
  // Authoritative too, and the one whose loss would be visible to strangers:
  // nothing else records that somebody asked us to stop emailing them, so an
  // empty table silently resumes mail to people who said no.
  'optouts'
  // One row per letter that arrived, partitioned by slug and day. Purely a
  // cost guard: it is what stops a forwarding loop from turning into thousands
  // of posts and a matching storage bill. Losing it costs one day's counting.
  'arrivals'
  // One row per archive that has been deleted and not yet erased, and the only
  // place the thirty-day promise is written down. Ordinarily empty.
  //
  // Authoritative, and its loss is the quiet kind: no letters would go, since
  // the blobs are all still there, but they would be stranded -- nothing would
  // ever erase them, and nothing would know to offer them back.
  'deletions'
  // One row per address we have sent to, holding the outcome of the last
  // attempt. Derived -- Cloudflare's suppression list is the authority -- and
  // it exists to be shown to an owner, so that "grandmother never hears from
  // us" is a visible fact rather than a KQL query nobody thinks to run.
  'deliveries'
  // One row per first letter that was refused, kept for as long as the inbox
  // blob it names. Authoritative in the same quiet way as `deletions`: a
  // rejection is otherwise invisible to everyone except the person it happened
  // to, who has been told only that it did not work.
  'rejections'
  // One row per sign-in identity, holding the last address it used. Derived,
  // and the repair is somebody signing in again.
  'identities'
]

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [
  for name in tableNames: {
    parent: tableService
    name: name
  }
]

var queueNames = [
  'ingest'
  'render'
  // Book assembly. Its own queue rather than a message type on `render`,
  // because the two have nothing in common but the word: a render is one
  // letter and takes a second, a book is the whole archive and takes
  // minutes, and sharing a queue would let one book hold up every letter
  // arriving behind it.
  'book'
]

resource queues 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = [
  for name in queueNames: {
    parent: queueService
    name: name
  }
]

// Four rules. The first two delete blobs that have served their purpose, the
// third deletes superseded versions of blobs still in use, and the last moves
// the one part of the archive nobody reads onto cheaper storage.
//
// The Worker writes every inbound message to the inbox container before
// anything parses it. Once ingest has copied a message to raw/{slug}/, the
// inbox copy is landing-zone residue. Versions and snapshots are expired too,
// or soft-delete quietly retains everything this rule is meant to remove.
//
// `exports` holds staged download archives -- a second copy of an entire
// family's correspondence, sitting under a URL somebody was emailed. Every
// byte of it is rebuildable from `raw/`, so keeping one is pure duplicated
// exposure once it has been fetched. A week is long enough for a link nobody
// opened until the weekend.
//
// Versioning is on account-wide, so every overwrite anywhere retains a full
// copy of the old bytes forever unless something expires them. `posts.json`
// holds every letter in an archive in a single blob, so editing one letter
// rewrites the whole array and retains the previous one entire. A month,
// because a bad render might not be noticed until somebody visits the site.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-inbox'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'inbox/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: inboxRetentionDays
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: inboxRetentionDays
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: inboxRetentionDays
                }
              }
            }
          }
        }
        {
          name: 'expire-exports'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'exports/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: exportRetentionDays
                }
              }
              snapshot: {
                delete: {
                  daysAfterCreationGreaterThan: exportRetentionDays
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: exportRetentionDays
                }
              }
            }
          }
        }
        {
          name: 'expire-archive-versions'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'rendered/'
                'raw/'
                'books/'
              ]
            }
            // Again no baseBlob action. These are the archive itself.
            actions: {
              version: {
                delete: {
                  daysAfterCreationGreaterThan: archiveVersionRetentionDays
                }
              }
            }
          }
        }
        {
          name: 'cool-raw'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'raw/'
              ]
            }
            // `raw/` is the largest thing here and the least read. Nothing on
            // a page view touches it: render reads a message once, minutes
            // after it arrives, and after that only an owner restoring a letter
            // to its original ever asks for it again. Cold stores it for a
            // fifth of what Hot does and charges for retrieval instead, which
            // is the right way round for bytes nobody fetches.
            //
            // A month, not immediately, so that the render queue is long done
            // and a fresh letter is still cheap to re-render.
            actions: {
              baseBlob: {
                tierToCold: {
                  daysAfterModificationGreaterThan: rawColdAfterDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Deployment storage — deliberately not the archive account.
//
// Soft delete and versioning are blob service settings, so an account gets them
// on every container or on none. The archive wants both: a letter removed by
// accident should be recoverable, and for many families raw/ is the only copy
// that exists. A deployment package wants neither. It is rebuilt from a git tag
// in minutes, and retaining every superseded copy of a 36 MB zip republished
// several times a day is how the archive account came to bill 6 GB to hold
// 1.4 GB of letters. Two accounts is the only way to give each the policy it
// actually wants.
//
// LRS rather than GRS for the same reason -- nothing here is a last surviving
// copy -- and Hot because the host re-reads the whole package on every cold
// start.
// ---------------------------------------------------------------------------

resource deployStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: deployStorageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource deployBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: deployStorage
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: {
      enabled: false
    }
    containerDeleteRetentionPolicy: {
      enabled: false
    }
  }
}

resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: deployBlobService
  name: 'app-package'
  properties: {
    publicAccess: 'None'
  }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    // A circuit breaker, not a budget. Ingestion is billed per GB with nothing
    // stopping it, so a function that starts logging in a loop bills until
    // someone notices -- and the way anyone would notice is the invoice.
    //
    // Deliberately set far above anything this service does. The busiest day in
    // the month to 31 August 2026 ingested 20 MB and the median day 5 MB, so a
    // gigabyte is roughly fifty times the worst real day. That headroom is the
    // point: a cap that trips during a legitimate burst would discard the very
    // telemetry needed to explain the burst, which is worse than the bill it
    // saved.
    workspaceCapping: {
      dailyQuotaGb: workspaceDailyQuotaGb
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// Key Vault
//
// Purge protection is ON as of the first real letters. It was off through
// Stage 1's build loop, when tearing the resource group down and rebuilding
// it was the development cycle and an unpurgeable vault would have blocked
// that. Real family letters now depend on the auth secrets this vault holds,
// so the trade inverted: a deleted vault is recoverable for the retention
// window and cannot be purged early by anyone, including us.
//
// This is a one-way switch -- Azure does not allow turning it back off. The
// practical cost is that the vault name is now reserved for seven days after
// any delete, so a full teardown-and-rebuild of this resource group has to
// use a new suffix rather than reusing this one.
// ---------------------------------------------------------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// Credential expiry alerting
//
// Every credential this service holds fails the same way: not with an error,
// but with a capability quietly disappearing. An expired Cloudflare token
// makes outbound mail return `10101 unauthorized`, which the mailer logs and
// swallows, so the first visible evidence is a pending site expiring unoffered
// -- roughly sixty days after the cause, by which time nothing links the two.
// An expired Entra secret ends Microsoft sign-in. Neither raises anything.
//
// Key Vault already knows the dates: `exp` is set on the secrets that have
// one, and the vault emits `SecretNearExpiry` thirty days ahead. Nothing was
// listening. These three resources are the listener.
//
// `exp` is advisory for secrets and is NOT enforced on read -- the vault will
// serve an expired secret quite happily. That is what makes the date safe to
// set honestly rather than defensively: it buys a warning and can never cause
// an outage of its own.
//
// Key Vault cannot renew any of these either. Auto-renewal is a
// certificates-only feature for integrated CAs, so the alert is the whole
// mechanism -- there is no self-healing path to build toward here.
// ---------------------------------------------------------------------------

resource alertGroup 'Microsoft.Insights/actionGroups@2024-10-01-preview' = if (!empty(alertEmail)) {
  name: '${namePrefix}-ag-${suffix}'
  // Action groups are global; `location` is not the resource group's.
  location: 'Global'
  properties: {
    // Twelve characters, hard limit. It prefixes the subject line.
    groupShortName: 'pdayletters'
    enabled: true
    emailReceivers: [
      {
        name: 'operator'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource vaultEvents 'Microsoft.EventGrid/systemTopics@2025-02-15' = if (!empty(alertEmail)) {
  name: '${namePrefix}-evt-${suffix}'
  location: location
  properties: {
    source: keyVault.id
    topicType: 'Microsoft.KeyVault.vaults'
  }
}

// The `MonitorAlert` destination is what keeps this codeless. The obvious
// alternative -- Event Grid to a Function, Function sends mail -- would have
// put the notification back inside the system it is watching, and would have
// meant the alerting path could break in exactly the ways it exists to report.
//
// Sev2 rather than Sev3: thirty days is enough warning that this is not
// urgent, but every one of these is a scheduled outage if it is ignored, and
// Sev3 is where advisory noise goes to be filtered.
resource secretExpiryAlert 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2025-02-15' = if (!empty(alertEmail)) {
  parent: vaultEvents
  name: 'secret-expiry'
  properties: {
    // Required, and not the default. A `MonitorAlert` destination accepts
    // CloudEvents 1.0 and nothing else; leaving this unset deploys the older
    // Event Grid schema and fails the whole template with a message that names
    // the schema but not the resource asking for it.
    eventDeliverySchema: 'CloudEventSchemaV1_0'
    filter: {
      // Only the two that mean something. The vault also emits
      // `SecretNewVersionCreated` on every write, which would turn a rotation
      // -- the fix -- into an alert of its own.
      includedEventTypes: [
        'Microsoft.KeyVault.SecretNearExpiry'
        'Microsoft.KeyVault.SecretExpired'
      ]
    }
    destination: {
      endpointType: 'MonitorAlert'
      properties: {
        severity: 'Sev2'
        description: 'A Key Vault secret is near expiry or has expired. See docs/todos.md for what each credential does and where it is rotated.'
        actionGroups: [
          alertGroup.id
        ]
      }
    }
    // Four tries over two hours, then stop. A destination that is an action
    // group either accepts immediately or is having an outage, and a
    // near-expiry event has thirty days of slack -- the next daily emission
    // covers a missed one.
    retryPolicy: {
      maxDeliveryAttempts: 4
      eventTimeToLiveInMinutes: 120
    }
  }
}

// ---------------------------------------------------------------------------
// The daily ingest cap
//
// `withinDailyCap` refuses a letter once an archive has taken 200 in a UTC
// day, and logs `ingest: daily cap reached` at error level when it does. Until
// this rule existed that line was visible only to somebody already looking at
// the logs, which is nobody -- and the failure it reports is precisely the one
// that produces no other symptom for weeks. A forwarding loop is silent from
// the outside: mail keeps arriving, posts keep appearing, and the first
// evidence anybody has is a storage bill or an owner asking why their archive
// has four thousand copies of the same letter.
//
// **The cap firing is never routine.** 200 is set far above the largest honest
// day -- a family forwarding two years of letters in one sitting clears it with
// room to spare -- so a single occurrence means either a loop or a person
// having a very bad time, and both want a human. Hence a threshold of zero
// rather than a rate, and Sev1: this one is costing money for as long as it is
// ignored, unlike the credential warnings which have thirty days of slack.
//
// **It also fires on the honest overrun**, and that is intended rather than
// tolerated. A real family who hit the cap have had letters refused, and while
// nothing is destroyed -- the raw message keeps its 30-day life in `inbox/` --
// somebody has to re-enqueue them, and nobody can do that without being told.
//
// Fifteen minutes, evaluated every fifteen. A tighter window would cost more
// query evaluations to tell us the same thing an hour sooner about a condition
// that has, by definition, already been running for a while.
// ---------------------------------------------------------------------------

resource ingestCapAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = if (!empty(alertEmail)) {
  name: '${namePrefix}-cap-${suffix}'
  location: location
  properties: {
    displayName: 'Daily ingest cap reached'
    description: 'An archive hit its daily letter cap. Usually a mail forwarding loop. See docs/plan.md, Phase 8, for the cap and how to replay refused letters.'
    severity: 1
    enabled: true
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          // `has` rather than `==`. The Node worker prefixes and decorates
          // trace messages in ways that have changed between host versions,
          // and an alert that silently stops matching is worse than no alert
          // -- it looks like everything is fine. The phrase is distinctive
          // enough that a substring cannot collide with anything else we log.
          query: 'traces | where message has "daily cap reached"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    // Fire once and stay quiet for six hours. A loop generates this line on
    // every message, and an alert group that mails on each one buries the
    // first -- which is the only one that had to be read.
    //
    // `autoMitigate` is false because the platform refuses the two together,
    // and because self-resolving is wrong here anyway: the condition is "an
    // archive was refused letters", and fifteen quiet minutes afterwards is
    // not evidence that anybody dealt with it. This one gets closed by hand,
    // by somebody who looked.
    autoMitigate: false
    muteActionsDuration: 'PT6H'
    actions: {
      actionGroups: [
        alertGroup.id
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Static Web App
//
// The custom domain is not declared here: binding it requires the DNS records
// to already resolve, and they must be grey-cloud / DNS-only at Cloudflare or
// validation never completes.
//
// The managed identity exists for exactly one purpose. Static Web Apps uses it
// to read identity-provider secrets out of Key Vault and for nothing else --
// it is not an identity the API runs as, because the API does not run here at
// all. See the linked backend below.
// ---------------------------------------------------------------------------

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: staticWebAppLocation
  sku: {
    name: staticWebAppSku
    tier: staticWebAppSku
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
    // Declared only so that a deployment does not propose removing them.
    // The repository link is metadata here rather than machinery -- the site
    // is built by a hand-written workflow authenticating with a deployment
    // token, not by one Azure generated -- but a template that omits these
    // asks ARM to clear them, and `what-if` reports exactly that. No
    // repository token is set or needed: it is required to *create* a
    // workflow, and this deployment does not.
    repositoryUrl: 'https://github.com/kurtzeborn/mission-journal'
    branch: 'main'
    provider: 'GitHub'
  }
}

// Settings for managed functions -- of which there are none, because the API
// is the linked Function App below, which carries its own settings and does
// not inherit these. They are still load-bearing for a second reason: this is
// where custom authentication reads its client IDs and secrets from, and
// declaring them here is what stops a later deployment from silently removing
// them and locking every reader out of the site.
//
// `clientSecretSettingName` in staticwebapp.config.json names the setting that
// holds the secret itself -- there is no indirection, despite the name in the
// documentation sample reading like there is. Point it at a setting holding
// another setting's name and the platform faithfully sends that name to the
// identity provider as the secret, the token exchange fails, and sign-in dies
// at the callback with a 401 long after the user has finished authenticating.
//
// The value is a Key Vault reference, resolved by Static Web Apps when it
// reads the setting, so the secret never exists in this template, in the
// resource, or in a deployment history.
resource staticWebAppSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: {
    ACCEPTED_INGEST_DOMAINS: acceptedIngestDomains
    MISSIONARY_DOMAINS: missionaryDomains
    STORAGE_ACCOUNT_NAME: storage.name
    KEY_VAULT_URI: keyVault.properties.vaultUri
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
    AZURE_CLIENT_ID: aadClientId
    AZURE_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${aadClientSecretName}/)'
    GOOGLE_CLIENT_ID: googleClientId
    GOOGLE_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${googleClientSecretName}/)'
  }
}

// ---------------------------------------------------------------------------
// The one role the Static Web App identity actually uses.
//
// There were blob and queue role assignments here once, on the theory that the
// managed Functions would reach storage by identity. They never could:
// managed functions get no managed identity on any plan, which is why the
// background work moved to its own Function App in the first place. Microsoft's
// own FAQ is explicit -- "if you need managed identity or Key Vault references
// in your API, use the bring your own Functions app feature." Two data-plane
// grants on a principal that cannot use them is not harmless; it is a standing
// misstatement of who can read the archive.
// ---------------------------------------------------------------------------

resource secretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, staticWebApp.id, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsUser
    )
    principalId: staticWebApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Background workers.
//
// These cannot live inside Static Web Apps: managed functions are limited to
// HTTP triggers and get no managed identity, so a queue trigger reaching
// storage by identity needs its own app. Flex Consumption rather than
// Consumption because Consumption is legacy — Linux Consumption retires in
// September 2028 and there is no in-place migration to Flex.
// ---------------------------------------------------------------------------

resource hostContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for name in hostContainerNames: {
    parent: blobService
    name: name
    properties: {
      publicAccess: 'None'
    }
  }
]

resource workerPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: workerPlanName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource workerApp 'Microsoft.Web/sites@2023-12-01' = {
  name: workerAppName
  location: location
  kind: 'functionapp,linux'
  // Two identities, and the split is the point. Everything the service does
  // routinely runs as the system-assigned one, which cannot permanently
  // delete anything. The erase timer -- and only the erase timer -- asks for
  // the user-assigned one by client ID.
  //
  // Attaching a second identity does not disturb that. The host's storage
  // connections below name no credential, and a bare connection resolves to
  // the system-assigned identity for as long as one is attached -- so the only
  // code that has to name an identity is the code that wants the other one.
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${purgeIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: workerPlan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${deployStorage.properties.primaryEndpoints.blob}${deployContainer.name}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      runtime: {
        name: 'node'
        version: '24'
      }
      // Always-ready instances would forfeit the free grant on both executions
      // and GB-seconds, and nothing here is latency-sensitive.
      //
      // 40 looks generous for a service this small and it is not. Opening an
      // album fires a photo request per picture at once, and each one holds an
      // instance for up to a second and a half while it reads a blob; the month
      // to 31 August 2026 peaked at 28 instances in a single minute serving 93
      // photo calls. Lower this and albums queue. Measure before touching it.
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
    }
    siteConfig: {
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storage.name
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        // Identity-based connection for the ingest and render queues. Naming
        // the service URIs without a credential selects the system-assigned
        // identity.
        {
          name: 'STORAGE__queueServiceUri'
          value: storage.properties.primaryEndpoints.queue
        }
        {
          name: 'STORAGE__blobServiceUri'
          value: storage.properties.primaryEndpoints.blob
        }
        {
          name: 'STORAGE_ACCOUNT_NAME'
          value: storage.name
        }
        {
          name: 'ACCEPTED_INGEST_DOMAINS'
          value: acceptedIngestDomains
        }
        {
          name: 'MISSIONARY_DOMAINS'
          value: missionaryDomains
        }
        // The authserv-id whose verdict we accept. Selected by name rather
        // than by position, because every message carries several
        // Authentication-Results headers and only our own inbound provider's
        // is evidence.
        {
          name: 'AUTHSERV_ID'
          value: authservId
        }
        {
          name: 'KEY_VAULT_URI'
          value: keyVault.properties.vaultUri
        }
        // Signs and verifies claim links. There is deliberately no default in
        // the code: a hard-coded fallback would make every claim token in the
        // system forgeable by anyone who read the source, and would do it
        // silently, because the flow would carry on working.
        {
          name: 'CLAIM_TOKEN_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${claimTokenKeyName}/)'
        }
        // Outbound mail. The token is a Key Vault reference for the same
        // reason the claim key is; the account id is not a secret and is
        // inert without it.
        {
          name: 'CLOUDFLARE_ACCOUNT_ID'
          value: cloudflareAccountId
        }
        {
          name: 'CLOUDFLARE_API_TOKEN'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${cloudflareTokenName}/)'
        }
        // Who the service is allowed to write to. Empty means nobody, which
        // is the safe direction while the recipient of every claim email is
        // computed from a stranger's mail headers. `*` opens it, and has to
        // be typed on purpose.
        {
          name: 'MAIL_ALLOWLIST'
          value: mailAllowlist
        }
        // Where claim links point. Not derived from the Static Web App's
        // generated hostname: links in email outlive deployments, and the
        // custom domain is the only name a recipient will recognise.
        {
          name: 'PUBLIC_BASE_URL'
          value: publicBaseUrl
        }
        // The same Google application the sign-in uses, borrowed for a second
        // purpose: an owner picking photographs out of their own Google Photos
        // library. One registration rather than two because it is one consent
        // screen to the person looking at it, and because the verification
        // Google requires for the Photos scope attaches to the application
        // rather than to the scope.
        //
        // Duplicated from the Static Web App's settings above rather than
        // shared. These are two resources with two identities, the Functions
        // host is the only one that performs the token exchange, and a setting
        // read by whichever happened to have it would be worse than a setting
        // written twice.
        {
          name: 'GOOGLE_CLIENT_ID'
          value: googleClientId
        }
        {
          name: 'GOOGLE_CLIENT_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${googleClientSecretName}/)'
        }
        // The printer. The two keys are references rather than values for the
        // same reason the claim key is; the base and the offering id are not
        // secret and are inert without them.
        {
          name: 'PEECHO_API_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${peechoApiKeyName}/)'
        }
        {
          name: 'PEECHO_SECRET_KEY'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${peechoSigningKeyName}/)'
        }
        {
          name: 'PEECHO_BASE'
          value: peechoBase
        }
        {
          name: 'PEECHO_OFFERING_ID'
          value: peechoOfferingId
        }
        // Who may administer any archive. Kept here rather than in a table so
        // that granting it takes Azure control-plane access -- a different
        // credential to the one it hands out, and separately recorded.
        {
          name: 'OPERATOR_EMAILS'
          value: operatorEmails
        }
        // Which identity the erase timer asks for. Nothing else reads this.
        //
        // If it is missing the timer refuses to run rather than falling back:
        // erasing with the app's own credential would appear to work, since it
        // can delete base blobs, and would leave every version behind -- a
        // family told their letters were destroyed and the letters still in
        // the account.
        {
          name: 'PURGE_IDENTITY_CLIENT_ID'
          value: purgeIdentity.properties.clientId
        }
      ]
    }
  }
}

// Blob access is split in two on purpose.
//
// The account-wide grant is Contributor, which cannot permanently delete: with
// versioning and soft delete on, a delete from this identity is recoverable for
// thirty days. That matters because this is the identity that processes
// inbound mail. It is the part of the system an attacker reaches first, and it
// should not be able to erase an archive beyond recovery.
//
// Owner is kept, but only on the containers the Functions host runs itself --
// the deployment package, its leases, its keys. The host needs more than
// Contributor there (Microsoft's own Flex Consumption guidance says otherwise,
// but narrowing it was not worth betting the ingest pipeline on). None of
// those containers holds a letter, so the extra power reaches nothing that
// matters.
//
// The permanentDelete right that a purge needs lives on a separate identity --
// see purgeIdentity below.
resource workerBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, workerApp.id, storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributor
    )
    principalId: workerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerHostRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (name, i) in hostContainerNames: {
    scope: hostContainers[i]
    name: guid(storage.id, workerApp.id, storageBlobDataOwner, name)
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        storageBlobDataOwner
      )
      principalId: workerApp.identity.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

// Scoped to the container rather than the account, matching workerHostRoles:
// the host needs to read and replace one blob, not enumerate an account.
resource workerDeployRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: deployContainer
  name: guid(deployStorage.id, workerApp.id, storageBlobDataOwner, deployContainer.name)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataOwner
    )
    principalId: workerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, workerApp.id, storageQueueDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageQueueDataContributor
    )
    principalId: workerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// The purge identity — permanent deletion, held apart.
//
// Deleting an archive has to mean deleted: a family that asks for their letters
// to be destroyed is not served by thirty days of recoverable versions sitting
// in the account. So something must hold permanentDelete.
//
// That something is deliberately not the app. This identity exists so that the
// right to erase is a credential the ingest path does not carry, rather than a
// capability sprayed across everything the Functions host can reach. Isolation
// here is by credential, not by process: the purge code asks for this identity
// by client ID, and nothing else does.
//
// It is attached to the function app above, alongside the system-assigned
// identity that everything else runs as. The two are told apart by the client
// ID in `PURGE_IDENTITY_CLIENT_ID`, which the erase timer is alone in reading.
// Everything else names no credential at all and so keeps running as the
// system-assigned identity.
// ---------------------------------------------------------------------------

resource purgeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-purge'
  location: location
}

// Storage Blob Data Contributor's permissions verbatim, plus the two rights a
// purge needs: deleteBlobVersion and permanentDelete.
//
// Both, and they are not the same right. `blobs/delete` only demotes a current
// version to history, which is what versioning is for and the opposite of what
// a purge is asked to do. Removing a named version needs deleteBlobVersion,
// and removing it beyond soft-delete recovery needs permanentDelete. Missing
// the first is a 403 that arrives only after the current blobs are already
// gone, which is exactly how it was found.
//
// The definition itself is not declared here. Role definitions live at
// subscription scope, and this is a resource-group deployment, so declaring it
// would quietly create a second, resource-group-scoped role beside the real
// one. It is version controlled as infra/purge-role.json and updated with:
//
//   az role definition update --role-definition @infra/purge-role.json
//
var purgeRoleId = 'f9e960ce-244b-4c38-af79-06e7bdafc5b4'

// Scoped to the containers a deletion actually empties. `inbox` is left out:
// it holds the untouched original of every message and is aged out by lifecycle
// rule, not by this timer.
var purgeContainerNames = [
  'raw'
  'rendered'
  'config'
  'exports'
  'pending'
  'books'
]

resource purgeRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for name in purgeContainerNames: {
    scope: containers[indexOf(containerNames, name)]
    name: guid(storage.id, purgeIdentity.id, name)
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        purgeRoleId
      )
      principalId: purgeIdentity.properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

// ---------------------------------------------------------------------------
// The identity GitHub Actions deploys this template as.
//
// Federated, not secret-bearing. GitHub mints a short-lived OIDC token
// asserting which repository and ref is running; the credential below says
// which of those assertions Entra will exchange for a real token. Nothing is
// stored on the GitHub side, so there is no deploy credential to rotate and
// nothing to add to the expiry table in todos.md.
//
// A user-assigned identity rather than an app registration for one reason
// that matters later: an app registration can have a client secret added to
// it, and this cannot. The safer option stays the only option.
//
// **The subject is pinned to one ref.** `ref:refs/heads/main` will not match a
// pull request, a tag, or another branch, which matters because this identity
// can write to every resource in the group. A wildcard subject here would let
// any fork's pull request deploy.
// ---------------------------------------------------------------------------

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-deploy'
  location: location
}

resource deployFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-main'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: '${githubSubjectPrefix}:ref:refs/heads/main'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// Its two role assignments are deliberately NOT declared here, and this is the
// one place in this file where leaving something out of the template is the
// safer choice.
//
// The identity needs `Contributor` to write the resources, and
// `Role Based Access Control Administrator` because this template creates role
// assignments and Contributor cannot. Declaring those two grants here would
// mean the deployment re-asserts them on every run — which in turn means the
// constraint on them has to permit granting Contributor and RBAC
// Administrator, and a workflow that can grant Contributor to anything is not
// meaningfully constrained at all.
//
// Held outside the template instead, the RBAC Administrator grant carries an
// ABAC condition restricting it to exactly the six roles assigned above, so a
// push to `main` cannot grant Owner, Contributor, or User Access
// Administrator to anything. Created once with:
//
//   az role assignment create --assignee-object-id <principalId> \
//     --assignee-principal-type ServicePrincipal --role Contributor --scope <rg>
//
//   az role assignment create --assignee-object-id <principalId> \
//     --assignee-principal-type ServicePrincipal \
//     --role 'Role Based Access Control Administrator' --scope <rg> \
//     --condition-version 2.0 --condition <see docs/plan.md>
//
// The credential that runs a deployment should not be grantable by that
// deployment. Its limit is that a condition can name roles but not scopes, so
// it constrains *which* role can be granted and not *where* — re-granting
// Storage Blob Data Owner account-wide is still expressible.

resource workerTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, workerApp.id, storageTableDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageTableDataContributor
    )
    principalId: workerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, workerApp.id, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      keyVaultSecretsUser
    )
    principalId: workerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// The Function App is also the site's /api backend.
//
// One app rather than two. The reader API therefore runs with the ingest
// identity's blob write rights, which is more authority than reading letters
// needs; a separate read-only app would be least-privilege but would mean
// splitting or packaging the shared lib/ code, and Static Web Apps permits
// only one linked Functions app per site in any case.
//
// Flex Consumption works here despite the documentation listing only
// Consumption, Premium, and Dedicated as supported plans for bring-your-own
// Functions. Verified against this resource, not inferred.
//
// The backend must keep the default `api` route prefix -- host.json must not
// override routePrefix, or every route arrives somewhere the site cannot
// reach.
// ---------------------------------------------------------------------------

resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2023-12-01' = {
  parent: staticWebApp
  name: workerApp.name
  properties: {
    backendResourceId: workerApp.id
    region: location
  }
}

// ---------------------------------------------------------------------------
// Easy Auth on the Function App -- the only thing standing between the letters
// and the open internet.
//
// The API validates no tokens of its own. It trusts the x-ms-client-principal
// header, which is sound only while nothing but Static Web Apps can reach the
// app. That property comes from this config and nowhere else.
//
// Linking a backend does NOT establish it. `az staticwebapp backends link`
// writes the azureStaticWebApps provider but leaves apple, azureActiveDirectory,
// facebook, gitHub, google, and legacyMicrosoftAccount enabled with empty
// registrations. Easy Auth then fails to initialize: before a restart it
// enforces nothing at all and a hand-forged header grants full access to every
// letter; after one, every request returns 400 "Login not supported for
// provider azureStaticWebApps". Both were observed on this resource. Every
// provider is therefore disabled explicitly -- including legacyMicrosoftAccount,
// which is absent from the default payload shape and silently re-materializes
// as enabled if it is not named.
//
// Auth settings do not take effect until the app restarts, and a successful
// deployment is not evidence that they took. Verify by calling the Function
// App's own *.azurewebsites.net hostname with a forged x-ms-client-principal
// and expecting 401.
// ---------------------------------------------------------------------------

resource workerAuth 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: workerApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
    globalValidation: {
      requireAuthentication: true
      // Return401 rather than a redirect. This app has no human visitors --
      // the only caller is the site's edge, and a redirect would turn an
      // authorization failure into an HTML login page arriving where JSON was
      // expected.
      unauthenticatedClientAction: 'Return401'
      redirectToProvider: 'azureStaticWebApps'
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '/.auth'
      }
      forwardProxy: {
        convention: 'NoProxy'
      }
    }
    identityProviders: {
      azureStaticWebApps: {
        enabled: true
        registration: {
          clientId: staticWebApp.properties.defaultHostname
        }
      }
      azureActiveDirectory: {
        enabled: false
      }
      apple: {
        enabled: false
      }
      facebook: {
        enabled: false
      }
      gitHub: {
        enabled: false
      }
      google: {
        enabled: false
      }
      twitter: {
        enabled: false
      }
      legacyMicrosoftAccount: {
        enabled: false
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Basic publishing credentials — closed.
//
// The deployment endpoint at {app}.scm.azurewebsites.net accepts two proofs
// that a caller may deploy: an Entra token, subject to RBAC and conditional
// access; and a username and password Azure mints for the app. The second pair
// is the whole content of a downloaded publish profile. It belongs to no
// person, never expires, and is not revoked when someone leaves a laptop in a
// taxi. Every copy ever downloaded from the portal, Visual Studio or VS Code is
// still valid while these are `true`.
//
// The reason this is not merely untidy: code deployed here runs *as this app*,
// and this app's identity reads the storage account and resolves Key Vault
// references. Deploy rights are therefore read access to every letter, reached
// without touching Entra at all.
//
// Nothing uses them. `deploy-functions.yml` authenticates by workload identity
// federation, and a hand publish through `func` uses the operator's own Azure
// login. Closing them removes an authentication path with no consumer.
//
// These are declared rather than switched off in the portal so that the setting
// is written down and re-asserted on every infrastructure deployment. A
// security control that exists only as a checkbox somebody once ticked is one
// undocumented click from being untrue.
//
// Written out twice rather than looped: `name` is a discriminator here, and a
// loop variable makes it undeterminable at compile time, which turns off type
// checking on the body (BCP225). Two lines of duplication buy back a typo in
// `allow` being caught by the compiler instead of by nobody.
// ---------------------------------------------------------------------------

resource workerScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: workerApp
  name: 'scm'
  properties: {
    allow: false
  }
}

resource workerFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: workerApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output appInsightsName string = appInsights.name
output staticWebAppName string = staticWebApp.name
output staticWebAppDefaultHostname string = staticWebApp.properties.defaultHostname
output functionAppName string = workerApp.name

