# Stores the Meta App Secret used by Azure Static Web Apps for Facebook Login.
#
# The App ID is public and belongs in main.bicep. The App Secret is entered as
# a SecureString so it is not left in shell history or console scrollback.
#
# Prompt for the secret:
#
#   .\infra\provision-facebook.ps1
#
# Or pass a SecureString:
#
#   $secret = Read-Host 'Meta App Secret' -AsSecureString
#   .\infra\provision-facebook.ps1 -AppSecret $secret

param(
    [string]$Subscription = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$Vault = 'mj-kv-utfe5uagkbz7q',
    [securestring]$AppSecret
)

$ErrorActionPreference = 'Stop'

if (-not $AppSecret) {
    $AppSecret = Read-Host 'Meta App Secret' -AsSecureString
}

$plainSecret = [System.Net.NetworkCredential]::new('', $AppSecret).Password
if (-not $plainSecret) { throw 'Meta App Secret is required' }

try {
    $secretId = az keyvault secret set --vault-name $Vault `
        --name facebook-app-secret --value $plainSecret `
        --subscription $Subscription --query id -o tsv --only-show-errors

    if ($LASTEXITCODE -ne 0 -or -not $secretId) {
        throw 'Azure CLI did not confirm that facebook-app-secret was set'
    }
}
finally {
    $plainSecret = $null
    $AppSecret = $null
    [GC]::Collect()
}

Write-Host "facebook-app-secret: set in ${Vault}"
