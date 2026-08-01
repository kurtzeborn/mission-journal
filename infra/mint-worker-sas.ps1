<#
.SYNOPSIS
    Mints the Cloudflare Email Worker's storage credentials.

.DESCRIPTION
    The Worker lives outside Azure, so it gets the narrowest scope in the
    system: write-only to the inbox container, add-only to the ingest queue.
    It cannot read, list, or delete anything, and it cannot see raw/ at all.

    Both tokens are backed by stored access policies. Deleting the policy
    revokes the token immediately, without rotating the account key and
    breaking everything else that uses it.

    Output is printed, never written to disk. Paste the values into Wrangler:
        npx wrangler secret put INBOX_SAS_URL
        npx wrangler secret put INGEST_QUEUE_SAS_URL
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$ResourceGroup = 'mission-journal',
    [string]$StorageAccount = 'mjstutfe5uagkbz7q',
    [string]$InboxContainer = 'inbox',
    [string]$IngestQueue = 'ingest',
    [int]$ValidDays = 365
)

$ErrorActionPreference = 'Stop'

$expiry = (Get-Date).ToUniversalTime().AddDays($ValidDays).ToString('yyyy-MM-ddTHH:mm:ssZ')
$blobPolicy = 'worker-write'
$queuePolicy = 'worker-add'

az account set --subscription $SubscriptionId

$key = az storage account keys list `
    --account-name $StorageAccount `
    --resource-group $ResourceGroup `
    --query '[0].value' --output tsv

# Write-only. No read, no list, no delete.
az storage container policy create `
    --container-name $InboxContainer `
    --name $blobPolicy `
    --permissions w `
    --expiry $expiry `
    --account-name $StorageAccount `
    --account-key $key `
    --output none

# Add-only. The Worker enqueues; it never reads or dequeues.
az storage queue policy create `
    --queue-name $IngestQueue `
    --name $queuePolicy `
    --permissions a `
    --expiry $expiry `
    --account-name $StorageAccount `
    --account-key $key `
    --output none

$blobSas = az storage container generate-sas `
    --name $InboxContainer `
    --policy-name $blobPolicy `
    --https-only `
    --account-name $StorageAccount `
    --account-key $key `
    --output tsv

$queueSas = az storage queue generate-sas `
    --name $IngestQueue `
    --policy-name $queuePolicy `
    --https-only `
    --account-name $StorageAccount `
    --account-key $key `
    --output tsv

Write-Host ''
Write-Host "Expires: $expiry" -ForegroundColor Yellow
Write-Host 'A silently expired SAS turns every inbound letter into an SMTP retry loop.'
Write-Host ''
Write-Host 'INBOX_SAS_URL'
Write-Host "https://$StorageAccount.blob.core.windows.net/$InboxContainer`?$blobSas"
Write-Host ''
Write-Host 'INGEST_QUEUE_SAS_URL'
Write-Host "https://$StorageAccount.queue.core.windows.net/$IngestQueue`?$queueSas"
Write-Host ''
Write-Host 'To revoke:' -ForegroundColor Yellow
Write-Host "  az storage container policy delete --container-name $InboxContainer --name $blobPolicy --account-name $StorageAccount --account-key <key>"
Write-Host "  az storage queue policy delete --queue-name $IngestQueue --name $queuePolicy --account-name $StorageAccount --account-key <key>"
