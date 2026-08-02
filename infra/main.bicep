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
Static Web App plan. Free through Phase 2. Standard from Phase 3, when Google
(a custom identity provider) is added. Managed identity is Standard-only, so on
Free the managed Functions reach storage with a connection string instead.
''')
@allowed([
  'Free'
  'Standard'
])
param staticWebAppSku string = 'Free'

@description('Comma-separated domains this service accepts inbound mail on. Recipient-side, not sender-side.')
param acceptedIngestDomains string

@description('Comma-separated domains treated as genuine missionary mail.')
param missionaryDomains string = 'missionary.org'

@description('Days before inbox blobs are deleted by lifecycle policy.')
param inboxRetentionDays int = 30

var suffix = uniqueString(resourceGroup().id)
var storageName = toLower('${namePrefix}st${suffix}')
var keyVaultName = toLower('${namePrefix}-kv-${suffix}')
var workspaceName = '${namePrefix}-log-${suffix}'
var appInsightsName = '${namePrefix}-ai-${suffix}'
var staticWebAppName = '${namePrefix}-swa-${suffix}'
var workerPlanName = '${namePrefix}-plan-${suffix}'
var workerAppName = '${namePrefix}-fn-${suffix}'

var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var storageBlobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageQueueDataContributor = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var storageTableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

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
var containerNames = [
  'inbox'
  'raw'
  'rendered'
  'config'
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
// Purge protection is deliberately OFF and soft-delete is at the 7-day
// minimum. Stage 1's loop involves tearing this resource group down and
// rebuilding it, and purge protection makes that irreversible for 90 days.
// Turn both on before real family data exists.
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
    enablePurgeProtection: null
    publicNetworkAccess: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// Static Web App
//
// Free through Phase 2. Phase 3 adds Google, which is a custom identity
// provider and forces Standard. The custom domain is not declared here:
// binding it requires the DNS records to already resolve, and they must be
// grey-cloud / DNS-only at Cloudflare or validation never completes.
//
// Managed identity is a Standard-only feature. The identity property must be
// absent entirely on Free — ARM rejects even `type: 'None'` with the
// misleading "SkuCode 'Free' is invalid". Bicep omits a null-valued property.
// ---------------------------------------------------------------------------

var useManagedIdentity = staticWebAppSku == 'Standard'

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: staticWebAppName
  location: staticWebAppLocation
  sku: {
    name: staticWebAppSku
    tier: staticWebAppSku
  }
  identity: useManagedIdentity ? { type: 'SystemAssigned' } : null
  properties: {
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
  }
}

var baseAppSettings = {
  ACCEPTED_INGEST_DOMAINS: acceptedIngestDomains
  MISSIONARY_DOMAINS: missionaryDomains
  STORAGE_ACCOUNT_NAME: storage.name
  KEY_VAULT_URI: keyVault.properties.vaultUri
  APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
}

// On Free there is no identity to authorize, so the managed Functions need a
// connection string. This is a real secret sitting in app settings, and it is
// the price of deferring Standard. It disappears at Phase 3.
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

resource staticWebAppSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: staticWebApp
  name: 'appsettings'
  properties: useManagedIdentity
    ? baseAppSettings
    : union(baseAppSettings, {
        STORAGE_CONNECTION_STRING: storageConnectionString
      })
}

// ---------------------------------------------------------------------------
// Role assignments — Standard only. The managed Functions reach storage and
// Key Vault by managed identity once the plan supports one.
// ---------------------------------------------------------------------------

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useManagedIdentity) {
  scope: storage
  name: guid(storage.id, staticWebApp.id, storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributor
    )
    principalId: staticWebApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useManagedIdentity) {
  scope: storage
  name: guid(storage.id, staticWebApp.id, storageQueueDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageQueueDataContributor
    )
    principalId: staticWebApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource secretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useManagedIdentity) {
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

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'app-package'
  properties: {
    publicAccess: 'None'
  }
}

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
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer.name}'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      runtime: {
        name: 'node'
        version: '22'
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
        {
          name: 'KEY_VAULT_URI'
          value: keyVault.properties.vaultUri
        }
      ]
    }
  }
}

// Blob Data Owner rather than Contributor: the Functions host manages its own
// leases and the deployment package container, which Contributor cannot do.
resource workerBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, workerApp.id, storageBlobDataOwner)
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

output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output appInsightsName string = appInsights.name
output staticWebAppName string = staticWebApp.name
output staticWebAppDefaultHostname string = staticWebApp.properties.defaultHostname
output functionAppName string = workerApp.name

