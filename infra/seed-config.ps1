<#
.SYNOPSIS
    Writes the Phase 0 bootstrap config/{slug}/ blobs by hand.

.DESCRIPTION
    In the real service these files are created by the claim flow (see
    "Ownership and the 60-day window" in docs/plan.md). Phase 0 has no claim
    flow yet, so the first site is seeded here instead.

    No email address is hardcoded in this repo. Pass -OwnerEmail explicitly.

    This is deliberately idempotent-by-overwrite: re-running it resets the ACL
    and profile to the seeded state, which is what you want while the reset
    script and ingest pipeline are being iterated on.

.EXAMPLE
    ./infra/seed-config.ps1 -Slug elder.example `
        -OwnerEmail someone@example.com -DisplayName 'Elder Example'
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$SubscriptionId = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$ResourceGroup = 'mission-journal',
    [string]$StorageAccount = 'mjstutfe5uagkbz7q',
    [string]$ConfigContainer = 'config',

    # Slug is the raw local-part of the missionary's @missionary.org address,
    # lowercased, with no other transformation. See "Missionary routing".
    [Parameter(Mandatory)][string]$Slug,

    # Becomes the sole owner. This address's DMARC result is what the ingest
    # classifier checks on every forward, so it must be a domain that
    # publishes a DMARC record.
    [Parameter(Mandatory)][string]$OwnerEmail,

    [Parameter(Mandatory)][string]$DisplayName
)

$ErrorActionPreference = 'Stop'

if ($Slug -ne $Slug.ToLowerInvariant()) {
    throw "Slug must be lowercase: '$Slug'"
}
if ($Slug -notmatch '^[a-z0-9._-]+$') {
    throw "Slug '$Slug' contains characters that are not unreserved in RFC 3986."
}

az account set --subscription $SubscriptionId | Out-Null
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

# verifiedMissionary is false: this owner was seeded by hand, not established
# through the claim@ flow, so it carries none of that flag's protection.
$acl = [ordered]@{
    slug    = $Slug
    members = @(
        [ordered]@{
            email              = $OwnerEmail.ToLowerInvariant()
            role               = 'owner'
            verifiedMissionary = $false
            addedAt            = $now
        }
    )
}

# alternateSenders stays empty until the owner admin UI exists (Phase 9).
# returnDate is omitted rather than null-filled; absent means "derive it".
# Named $profileDoc because $profile is an automatic PowerShell variable.
$profileDoc = [ordered]@{
    slug             = $Slug
    displayName      = $DisplayName
    alternateSenders = @()
    createdAt        = $now
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null

try {
    $files = @{
        'acl.json'     = $acl
        'profile.json' = $profileDoc
    }

    foreach ($name in $files.Keys) {
        $localPath = Join-Path $temp $name
        $files[$name] | ConvertTo-Json -Depth 5 | Set-Content -Path $localPath -Encoding utf8
        $blobName = "$Slug/$name"

        if ($PSCmdlet.ShouldProcess("$ConfigContainer/$blobName", 'Upload')) {
            az storage blob upload `
                --account-name $StorageAccount `
                --container-name $ConfigContainer `
                --name $blobName `
                --file $localPath `
                --content-type 'application/json' `
                --auth-mode login `
                --overwrite true `
                --only-show-errors | Out-Null
            Write-Host "wrote $ConfigContainer/$blobName"
        }
    }
}
finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Verify with:'
Write-Host "  az storage blob download --account-name $StorageAccount --container-name $ConfigContainer --name $Slug/acl.json --auth-mode login --file -"
