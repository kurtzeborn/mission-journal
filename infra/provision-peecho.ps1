# Puts the printer's keys where the Function App can reach them.
#
# The same shape as `provision-claim.ps1` and for the same reason: Bicep can
# declare the app settings, but it cannot own the secret values without taking
# them as parameters, which writes them into the deployment history in plain
# text. So they are read here, written straight to Key Vault, and everything
# downstream refers to them by name.
#
# Only the two secrets. Which environment to print in and which product to
# print are settings in `main.bicep`, where they can be reviewed and where a
# redeploy cannot quietly undo them.
#
# Unlike the claim key these are not generated -- they belong to a Peecho
# account and are copied from its dashboard, under Settings > API. Read as
# secure strings so they are not left in the shell's history or in the console
# scrollback.
#
#   Merchant API key   -> peecho-api-key      (authenticates create-publication)
#   Secret key         -> peecho-secret-key   (signs the webhooks they send us)
#
# Re-running is safe and overwrites. Unlike the claim key these can be rotated
# in their dashboard without invalidating anything of ours.

param(
    [string]$Subscription = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$Vault = 'mj-kv-utfe5uagkbz7q',
    [string]$FunctionApp = 'mj-fn-utfe5uagkbz7q',
    [string]$ResourceGroup = 'mission-journal',

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

# --- pick them up -----------------------------------------------------------
#
# Key Vault references are resolved when the app starts and then cached for the
# best part of a day. Creating the secret is not enough on its own: without
# this the app carries on holding the unresolved reference, which the code
# reads -- correctly -- as no printer at all. So the restart is part of
# provisioning rather than an afterthought.
az functionapp restart --name $FunctionApp --resource-group $ResourceGroup `
    --subscription $Subscription -o none
Write-Host "${FunctionApp}: restarted"

# The half of the integration that cannot be automated: Peecho posts to us, so
# the URLs have to be typed into their dashboard by hand.
Write-Host ''
Write-Host 'Still to do by hand, in the Peecho dashboard under Settings > API > Webhooks:'
Write-Host '  Order placed        https://pdayletters.com/api/peecho/placed'
Write-Host '  Status update       https://pdayletters.com/api/peecho/status'
