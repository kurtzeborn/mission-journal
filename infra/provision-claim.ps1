# Provisions the pieces the claim flow needs that Bicep cannot safely own.
#
# The signing key is generated here and never printed. Bicep could declare the
# secret, but only by taking its value as a parameter, which would put it in
# the deployment history in plain text -- so it is created out of band and
# only referenced by name.

param(
    [string]$Subscription = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$Vault = 'mj-kv-utfe5uagkbz7q',
    [string]$Account = 'mjstutfe5uagkbz7q',
    [string]$FunctionApp = 'mj-fn-utfe5uagkbz7q',
    [string]$ResourceGroup = 'mission-journal'
)

$ErrorActionPreference = 'Stop'

# --- signing key ------------------------------------------------------------
$existing = az keyvault secret list --vault-name $Vault --subscription $Subscription `
    --query "[?name=='claim-token-key'] | length(@)" -o tsv

if ($existing -eq '0') {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $key = [Convert]::ToBase64String($bytes)

    az keyvault secret set --vault-name $Vault --name claim-token-key `
        --value $key --subscription $Subscription -o none

    $key = $null
    $bytes = $null
    [GC]::Collect()
    Write-Host 'claim-token-key: created'
}
else {
    # Never regenerated on a re-run. Rotating this key invalidates every claim
    # link already in somebody's inbox.
    Write-Host 'claim-token-key: already exists, left alone'
}

# --- tables -----------------------------------------------------------------
foreach ($table in @('memberships', 'users', 'sites')) {
    az storage table create --name $table --account-name $Account `
        --auth-mode login --subscription $Subscription -o none
    Write-Host "table ${table}: ready"
}

# --- app setting ------------------------------------------------------------
$uri = az keyvault show --name $Vault --subscription $Subscription --query properties.vaultUri -o tsv
$reference = "@Microsoft.KeyVault(SecretUri=${uri}secrets/claim-token-key/)"

# Through a file, not an argument. `az` on Windows is a batch shim, and cmd
# treats the parentheses in a Key Vault reference as syntax -- passing it
# inline fails with "-o was unexpected at this time" *after* printing what
# looks like a successful command line. The setting is a reference, not a
# secret, so a temp file costs nothing.
$settingsFile = Join-Path $env:TEMP 'mj-claim-setting.json'
@(@{ name = 'CLAIM_TOKEN_KEY'; value = $reference }) | ConvertTo-Json -AsArray |
    Set-Content -Path $settingsFile -Encoding utf8

az functionapp config appsettings set --name $FunctionApp --resource-group $ResourceGroup `
    --subscription $Subscription --settings "@$settingsFile" -o none

Remove-Item $settingsFile -ErrorAction SilentlyContinue

$applied = az functionapp config appsettings list --name $FunctionApp --resource-group $ResourceGroup `
    --subscription $Subscription --query "[?name=='CLAIM_TOKEN_KEY'] | length(@)" -o tsv

if ($applied -eq '1') { Write-Host 'CLAIM_TOKEN_KEY: set' }
else { throw 'CLAIM_TOKEN_KEY was not applied' }
