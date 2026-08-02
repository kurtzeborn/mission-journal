<#
.SYNOPSIS
    Wipes one missionary slug from storage so the ingest loop can be re-run clean.

.DESCRIPTION
    This is the honest first draft of the Phase 9 deletion purge. It is
    deliberately more thorough than "delete the blobs", because the account has
    both versioning and soft delete enabled and neither the portal nor the
    az CLI can actually remove a version.

    Purging a version takes two passes against the REST API:

      1. DELETE ?versionid=...                      -> soft-deletes the version
      2. DELETE ?versionid=...&deletetype=permanent -> removes it for real

    Pass 2 returns 409 BlobSnapshotNotSoftDeleted if you skip pass 1, so the
    order is not optional. Both require:

      * deleteRetentionPolicy.allowPermanentDelete = true on the blob service
        (set in main.bicep; not settable from the az CLI), and
      * an identity holding the blobs/permanentDelete/action data action.
        Storage Blob Data *Contributor* does not have it -- its data actions
        are an explicit list without it. Storage Blob Data *Owner* does, via
        the blobs/* wildcard.

    az storage blob delete cannot do any of this: it has no --version-id, and
    passing ?versionid= via --blob-url is silently ignored, which deletes the
    base blob instead and looks like it worked.

    Scope, by default:
      raw/{slug}/        purged
      rendered/{slug}/   purged
      pending/{slug}/    purged if the container exists (Stage 2)
      config/{slug}/     KEPT unless -IncludeConfig
      inbox/             KEPT unless -IncludeInbox (not slug-scoped)

    config/ is kept by default because it holds the hand-seeded ACL and
    profile -- the thing you are least likely to want to recreate by hand.

    inbox/ is opt-in and all-or-nothing: blobs there are named by ULID with no
    slug in the path, so there is nothing to filter on. Clearing it also clears
    the ingest and render queues, because queued ULIDs pointing at deleted
    blobs produce failures that look like parser bugs.

.EXAMPLE
    ./infra/reset-slug.ps1 -Slug elder.example -WhatIf

.EXAMPLE
    ./infra/reset-slug.ps1 -Slug elder.example -IncludeInbox
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$SubscriptionId = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$ResourceGroup = 'mission-journal',
    [string]$StorageAccount = 'mjstutfe5uagkbz7q',

    [Parameter(Mandatory)][string]$Slug,

    # Also delete config/{slug}/ -- the seeded ACL and profile.
    [switch]$IncludeConfig,

    # Also empty the inbox container and the ingest/render queues.
    [switch]$IncludeInbox
)

$ErrorActionPreference = 'Stop'

# A slug that is empty, or used as a prefix without its trailing separator,
# would match far more than intended: 'elder' must not match 'elder.example'.
# Every prefix below is built as "{slug}/".
if ([string]::IsNullOrWhiteSpace($Slug)) { throw 'Slug is required.' }
if ($Slug -notmatch '^[a-z0-9._-]+$') { throw "Refusing to act on slug '$Slug'." }
if ($Slug -match '^\.+$') { throw "Refusing to act on slug '$Slug'." }

az account set --subscription $SubscriptionId | Out-Null

$endpoint = "https://$StorageAccount.blob.core.windows.net"
$token = az account get-access-token --resource https://storage.azure.com/ --query accessToken -o tsv
if (-not $token) { throw 'Could not acquire a storage access token.' }
$headers = @{ Authorization = "Bearer $token"; 'x-ms-version' = '2023-11-03' }

function Get-BlobVersions {
    param([string]$Container, [string]$Prefix)

    # -o tsv, not ConvertFrom-Json: PowerShell coerces the ISO-8601 versionId
    # into a DateTime and then stringifies it in local format, producing a
    # value the service does not recognise.
    # 'dv' = deleted + versions. Without it only current blobs come back and
    # every version survives the wipe.
    $listArgs = @(
        'storage', 'blob', 'list',
        '--account-name', $StorageAccount,
        '--container-name', $Container,
        '--include', 'dv',
        '--auth-mode', 'login',
        '--query', '[].[name,versionId,deleted]',
        '-o', 'tsv', '--only-show-errors'
    )
    if ($Prefix) { $listArgs += @('--prefix', $Prefix) }

    $raw = az @listArgs
    if (-not $raw) { return @() }

    @($raw -split "`n" | Where-Object { $_.Trim() } | ForEach-Object {
            $f = $_ -split "`t"
            [pscustomobject]@{
                Name      = $f[0].Trim()
                VersionId = if ($f.Count -gt 1) { $f[1].Trim() } else { '' }
                Deleted   = ($f.Count -gt 2 -and $f[2].Trim() -eq 'True')
            }
        })
}

function Get-CurrentBlobs {
    param([string]$Container, [string]$Prefix)

    # No --include: current blobs only, which is exactly the set that must be
    # demoted before their versions can be purged.
    $listArgs = @(
        'storage', 'blob', 'list',
        '--account-name', $StorageAccount,
        '--container-name', $Container,
        '--auth-mode', 'login',
        '--query', '[].name',
        '-o', 'tsv', '--only-show-errors'
    )
    if ($Prefix) { $listArgs += @('--prefix', $Prefix) }

    $raw = az @listArgs
    if (-not $raw) { return @() }
    @($raw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-BlobUri {
    param([string]$Container, [string]$Name, [string]$VersionId, [switch]$Permanent)

    # Escape each path segment but keep '/' as a separator.
    $path = ($Name -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $uri = "$endpoint/$Container/$path"
    if ($VersionId) { $uri += "?versionid=$([uri]::EscapeDataString($VersionId))" }
    if ($Permanent) { $uri += '&deletetype=permanent' }
    $uri
}

function Invoke-BlobDelete {
    param([string]$Uri)
    try {
        Invoke-WebRequest -Uri $Uri -Method DELETE -Headers $headers -TimeoutSec 30 | Out-Null
        return $true
    }
    catch {
        $code = $_.Exception.Response.StatusCode.value__
        # 404 counts as success: something else already removed it.
        if ($code -eq 404) { return $true }
        $detail = $_.ErrorDetails.Message
        if ($detail -match '<Message>([^<\r\n]+)') { $detail = $Matches[1] }
        Write-Warning "DELETE $code -- $detail"
        return $false
    }
}

function Clear-Prefix {
    # SupportsShouldProcess is required here, not just on the script: $PSCmdlet
    # is $null in a simple function, so ShouldProcess would return nothing and
    # every delete would be silently skipped. -WhatIf propagates in via the
    # inherited $WhatIfPreference.
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$Container, [string]$Prefix)

    $purged = 0

    # Pass 0 -- delete the base blobs. A version that is still the current
    # version of a live blob cannot be permanently deleted: the service
    # returns 403 OperationNotAllowedOnRootBlob. Deleting the base blob first
    # demotes it to an ordinary non-current version.
    foreach ($b in Get-CurrentBlobs -Container $Container -Prefix $Prefix) {
        if (-not $PSCmdlet.ShouldProcess("$Container/$b", 'Delete base blob')) { continue }
        $null = Invoke-BlobDelete -Uri (Get-BlobUri -Container $Container -Name $b)
    }

    # Pass 1 -- soft-delete every live version.
    foreach ($b in Get-BlobVersions -Container $Container -Prefix $Prefix) {
        if ($b.Deleted) { continue }
        if (-not $PSCmdlet.ShouldProcess("$Container/$($b.Name)@$($b.VersionId)", 'Soft-delete')) { continue }
        $null = Invoke-BlobDelete -Uri (Get-BlobUri -Container $Container -Name $b.Name -VersionId $b.VersionId)
    }

    # Pass 2 -- permanently remove what is now soft-deleted. Re-listed rather
    # than reusing pass 1's results, so anything soft-deleted by an earlier run
    # is collected too.
    foreach ($b in Get-BlobVersions -Container $Container -Prefix $Prefix) {
        if (-not $PSCmdlet.ShouldProcess("$Container/$($b.Name)@$($b.VersionId)", 'Permanently delete')) { continue }
        $uri = Get-BlobUri -Container $Container -Name $b.Name -VersionId $b.VersionId -Permanent
        if (Invoke-BlobDelete -Uri $uri) { $purged++ }
    }

    Write-Host ("  {0,-10} {1} version(s) purged" -f $Container, $purged)
    return $purged
}

$existing = az storage container list --account-name $StorageAccount --auth-mode login `
    --query '[].name' -o tsv --only-show-errors
$existing = @($existing -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$targets = @('raw', 'rendered', 'pending')
if ($IncludeConfig) { $targets += 'config' }
$targets = @($targets | Where-Object { $existing -contains $_ })

Write-Host "Resetting slug '$Slug' in $StorageAccount"
Write-Host ''

$total = 0
foreach ($c in $targets) {
    $total += Clear-Prefix -Container $c -Prefix "$Slug/"
}

if ($IncludeInbox) {
    Write-Host ''
    Write-Host 'Clearing inbox and queues (not slug-scoped):'
    $total += Clear-Prefix -Container 'inbox' -Prefix ''

    foreach ($q in @('ingest', 'render')) {
        if ($PSCmdlet.ShouldProcess("queue/$q", 'Clear')) {
            az storage message clear --account-name $StorageAccount --queue-name $q `
                --auth-mode login --only-show-errors -o none
            Write-Host "  queue      $q cleared"
        }
    }
}

Write-Host ''
Write-Host "$total version(s) purged."

if (-not $IncludeConfig) {
    Write-Host "config/$Slug/ kept. Pass -IncludeConfig to remove the ACL and profile."
}
