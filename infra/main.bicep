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

// The containers the Functions host keeps for itself: the deployment package,
// the lease blobs it coordinates with, and its own key material. Declared here
// only so that a role assignment can be scoped to them -- see workerHostRoles.
// The host creates them on its own if they are missing.
var hostContainerNames = [
  'app-package'
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
    accessTier: 'Cool'
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
]

resource queues 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = [
  for name in queueNames: {
    parent: queueService
    name: name
  }
]

// The Worker writes every inbound message to the inbox container before
// anything parses it. Once ingest has copied a message to raw/{slug}/, the
// inbox copy is landing-zone residue. Versions and snapshots are expired too,
// or soft-delete quietly retains everything this rule is meant to remove.
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
      ]
    }
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
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: workerPlan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${hostContainerNames[0]}'
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
// It is not attached to the function app yet. Attaching it before there is
// purge code to use it would only make managed-identity selection ambiguous for
// the code already running, and buy nothing.
// ---------------------------------------------------------------------------

resource purgeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-purge'
  location: location
}

// Storage Blob Data Contributor's permissions verbatim, plus permanentDelete.
//
// The definition itself is not declared here. Role definitions live at
// subscription scope, and this is a resource-group deployment, so declaring it
// would quietly create a second, resource-group-scoped role beside the real
// one. It is version controlled as infra/purge-role.json and created with:
//
//   az role definition create --role-definition @infra/purge-role.json
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

