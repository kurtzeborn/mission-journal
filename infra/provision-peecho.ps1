# Puts the printer's keys where the Function App can reach them.
#
# The same shape as `provision-claim.ps1` and for the same reason: Bicep can
# declare the app settings, but it cannot own the secret values without taking
# them as parameters, which writes them into the deployment history in plain
# text. So they are read here, written straight to Key Vault, and everything
# downstream refers to them by name.
#
# Unlike the claim key these are not generated -- they belong to a Peecho
# account and are copied from its dashboard, under Settings > API. Read as
# secure strings so they are not left in the shell's history or in the console
# scrollback.
#
#   Merchant API key   -> peecho-api-key      (authenticates create-publication)
#   Secret key         -> peecho-secret-key   (signs the webhooks they send us)
#
# Re-running is safe and overwrites, because unlike the claim key these can be
# rotated in their dashboard without invalidating anything of ours.

param(
    [string]$Subscription = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$Vault = 'mj-kv-utfe5uagkbz7q',
    [string]$FunctionApp = 'mj-fn-utfe5uagkbz7q',
    [string]$ResourceGroup = 'mission-journal',

    # Their live environment. The default is production here, unlike the code's
    # own default, because somebody running this script is switching printing
    # on -- but it is still a parameter, so a test account can be pointed at
    # `https://test.www.peecho.com` without editing anything.
    [string]$Base = 'https://www.peecho.com',

    # The exact product: hardcover, Letter, 2.5mm board, gloss 200gsm. Without
    # it the buyer is asked to pick a product category before they can see
    # their own book. Read off the checkout the configurator builds.
    [string]$OfferingId = '7230432',

    [securestring]$ApiKey,
    [securestring]$SecretKey
)

$ErrorActionPreference = 'Stop'

if (-not $ApiKey) { $ApiKey = Read-Host 'Peecho merchant API key' -AsSecureString }
if (-not $SecretKey) { $SecretKey = Read-Host 'Peecho secret key' -AsSecureString }

$plainApi = [System.Net.NetworkCredential]::new('', $ApiKey).Password
$plainSecret = [System.Net.NetworkCredential]::new('', $SecretKey).Password

if (-not $plainApi -or -not $plainSecret) { throw 'Both keys are required' }

# --- secrets ----------------------------------------------------------------
az keyvault secret set --vault-name $Vault --name peecho-api-key `
    --value $plainApi --subscription $Subscription -o none
Write-Host 'peecho-api-key: set'

az keyvault secret set --vault-name $Vault --name peecho-secret-key `
    --value $plainSecret --subscription $Subscription -o none
Write-Host 'peecho-secret-key: set'

$plainApi = $null
$plainSecret = $null
[GC]::Collect()

# --- app settings -----------------------------------------------------------
$uri = az keyvault show --name $Vault --subscription $Subscription --query properties.vaultUri -o tsv

# Through a file rather than as arguments. `az` on Windows is a batch shim and
# cmd reads the parentheses in a Key Vault reference as syntax, failing with
# "-o was unexpected at this time" after printing what looks like a working
# command line. References are not secrets, so a temp file costs nothing.
$settingsFile = Join-Path $env:TEMP 'mj-peecho-settings.json'
@(
    @{ name = 'PEECHO_API_KEY'; value = "@Microsoft.KeyVault(SecretUri=${uri}secrets/peecho-api-key/)" }
    @{ name = 'PEECHO_SECRET_KEY'; value = "@Microsoft.KeyVault(SecretUri=${uri}secrets/peecho-secret-key/)" }
    @{ name = 'PEECHO_BASE'; value = $Base }
    @{ name = 'PEECHO_OFFERING_ID'; value = $OfferingId }
) | ConvertTo-Json -AsArray | Set-Content -Path $settingsFile -Encoding utf8

az functionapp config appsettings set --name $FunctionApp --resource-group $ResourceGroup `
    --subscription $Subscription --settings "@$settingsFile" -o none

Remove-Item $settingsFile -ErrorAction SilentlyContinue

$applied = az functionapp config appsettings list --name $FunctionApp --resource-group $ResourceGroup `
    --subscription $Subscription --query "[?starts_with(name, 'PEECHO_')] | length(@)" -o tsv

if ($applied -eq '4') { Write-Host "PEECHO_*: set, pointing at $Base" }
else { throw "Expected four PEECHO_ settings, found $applied" }

# The half of the integration that cannot be automated: Peecho posts to us,
# so the URL has to be typed into their dashboard by hand.
Write-Host ''
Write-Host 'Still to do by hand, in the Peecho dashboard under Settings > API > Webhooks:'
Write-Host '  Order placed        https://pdayletters.com/api/peecho/placed'
Write-Host '  Status update       https://pdayletters.com/api/peecho/status'
