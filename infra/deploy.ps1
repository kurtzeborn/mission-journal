<#
.SYNOPSIS
    Creates the mission-journal resource group and deploys infra/main.bicep.

.EXAMPLE
    ./deploy.ps1 -WhatIf
    ./deploy.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # "MSDN Subscription" in the Kurtzeborn Family tenant. Pinned by ID
    # because the signed-in account defaults to "Scott K Projects".
    [string]$SubscriptionId = '41fbccc1-bb65-416d-816d-30cb2a41dd9b',
    [string]$ResourceGroup = 'mission-journal',
    [string]$Location = 'westus2',
    [string]$DeploymentName = "mission-journal-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
)

$ErrorActionPreference = 'Stop'
$bicep = Join-Path $PSScriptRoot 'main.bicep'
$params = Join-Path $PSScriptRoot 'main.bicepparam'

az account set --subscription $SubscriptionId
$current = az account show --query 'name' --output tsv
Write-Host "Subscription: $current ($SubscriptionId)"

Write-Host "Ensuring resource group '$ResourceGroup' in $Location..."
az group create --name $ResourceGroup --location $Location --output none

if ($WhatIfPreference) {
    Write-Host 'Running what-if...'
    az deployment group what-if `
        --resource-group $ResourceGroup `
        --template-file $bicep `
        --parameters $params
    return
}

Write-Host "Deploying '$DeploymentName'..."
az deployment group create `
    --name $DeploymentName `
    --resource-group $ResourceGroup `
    --template-file $bicep `
    --parameters $params `
    --query 'properties.outputs' `
    --output json
