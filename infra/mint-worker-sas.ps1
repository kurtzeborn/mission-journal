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

    Output is printed, never written to disk. The values are bare query
    strings, not URLs: the Worker builds its own URL from the STORAGE_ACCOUNT
    and container vars in wrangler.toml and appends the token. Set them in the
    Cloudflare dashboard under Settings -> Variables and Secrets, or:
        npx wrangler secret put INBOX_SAS
        npx wrangler secret put QUEUE_SAS
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

# Policy creation is separate from token minting because the two have
# different lifetimes: the policy is the revocation handle and outlives any
# number of reissued tokens. Creating one that already exists is an error, so
# re-running this script to reissue a token must not try.
$blobPolicies = az storage container policy list `
    --container-name $InboxContainer `
    --account-name $StorageAccount `
    --account-key $key `
    --output json | ConvertFrom-Json

if ($blobPolicies.PSObject.Properties.Name -notcontains $blobPolicy) {
    # Write-only. No read, no list, no delete.
    az storage container policy create `
        --container-name $InboxContainer `
        --name $blobPolicy `
        --permissions w `
        --expiry $expiry `
        --account-name $StorageAccount `
        --account-key $key `
        --output none
    Write-Host "Created blob policy $blobPolicy (expires $expiry)"
} else {
    Write-Host "Reusing blob policy $blobPolicy (expires $($blobPolicies.$blobPolicy.expiry))"
}

$queuePolicies = az storage queue policy list `
    --queue-name $IngestQueue `
    --account-name $StorageAccount `
    --account-key $key `
    --output json | ConvertFrom-Json

if ($queuePolicies.PSObject.Properties.Name -notcontains $queuePolicy) {
    # Add-only. The Worker enqueues; it never reads or dequeues.
    az storage queue policy create `
        --queue-name $IngestQueue `
        --name $queuePolicy `
        --permissions a `
        --expiry $expiry `
        --account-name $StorageAccount `
        --account-key $key `
        --output none
    Write-Host "Created queue policy $queuePolicy (expires $expiry)"
} else {
    Write-Host "Reusing queue policy $queuePolicy (expires $($queuePolicies.$queuePolicy.expiry))"
}

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
Write-Host 'The expiry that matters is the policy, not the token.' -ForegroundColor Yellow
Write-Host 'A silently expired SAS turns every inbound letter into an SMTP retry loop.'
Write-Host ''
Write-Host 'INBOX_SAS'
Write-Host $blobSas
Write-Host ''
Write-Host 'QUEUE_SAS'
Write-Host $queueSas
Write-Host ''
Write-Host 'These are query strings, not URLs — the Worker builds the URL itself.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'To revoke:' -ForegroundColor Yellow
Write-Host "  az storage container policy delete --container-name $InboxContainer --name $blobPolicy --account-name $StorageAccount --account-key <key>"
Write-Host "  az storage queue policy delete --queue-name $IngestQueue --name $queuePolicy --account-name $StorageAccount --account-key <key>"
