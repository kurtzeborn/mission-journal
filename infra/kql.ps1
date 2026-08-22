#Requires -Version 7.0
<#
    Runs a KQL query against Application Insights and emits one object per row,
    so the result can be piped into Where-Object and Format-Table.

    It posts to the REST API rather than calling `az monitor app-insights query`,
    which hangs when it is run non-interactively.

    Telemetry is retained for 30 days; anything older than that is gone and no
    query will find it.
#>
param(
    [Parameter(Mandatory)][string]$Kql,
    [string]$AppId = '2c0139bf-a878-465f-a14a-3b0798d783c8',
    [string]$Subscription = '41fbccc1-bb65-416d-816d-30cb2a41dd9b'
)

$token = (az account get-access-token --resource 'https://api.applicationinsights.io' --subscription $Subscription -o json | ConvertFrom-Json).accessToken
if (-not $token) { throw 'Could not get a token. Run `az login` first.' }

$body = @{ query = $Kql } | ConvertTo-Json -Compress

$response = Invoke-RestMethod -Method Post -Uri "https://api.applicationinsights.io/v1/apps/$AppId/query" `
    -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } -Body $body

$columns = $response.tables[0].columns.name
foreach ($row in $response.tables[0].rows) {
    $record = [ordered]@{}
    for ($i = 0; $i -lt $columns.Count; $i++) { $record[$columns[$i]] = $row[$i] }
    [pscustomobject]$record
}
