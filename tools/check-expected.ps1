#Requires -Version 7.0
<#
    Checks that every fixture has an .expected.json sibling, that each parses,
    and that the structural claims in it match the fixture it describes.
#>
$dir = Join-Path $PSScriptRoot '..' 'tests' 'fixtures'
if (-not (Test-Path $dir)) { $dir = 'C:\repos\mission-journal\tests\fixtures' }
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$fail = 0

foreach ($eml in Get-ChildItem (Join-Path $dir '*.eml') | Sort-Object Name) {
    $sidecar = [IO.Path]::ChangeExtension($eml.FullName, $null) + 'expected.json'
    if (-not (Test-Path $sidecar)) { "MISSING sidecar: $($eml.Name)"; $fail++; continue }

    try { $e = Get-Content $sidecar -Raw | ConvertFrom-Json }
    catch { "INVALID JSON: $(Split-Path $sidecar -Leaf) - $($_.Exception.Message)"; $fail++; continue }

    $raw = $latin1.GetString([IO.File]::ReadAllBytes($eml.FullName))
    $unfolded = [regex]::Replace($raw, "`r`n[ `t]+", ' ')

    # embeddedPartType must be present in the message exactly when asserted.
    $hasRfc822 = $unfolded -match '(?i)Content-Type:\s*message/rfc822'
    $hasOctet = $unfolded -match '(?i)Content-Type:\s*application/octet-stream'
    $claimed = $e.embeddedPartType
    $actual = if ($hasRfc822) { 'message/rfc822' } elseif ($hasOctet) { 'application/octet-stream' } else { $null }
    if ($claimed -ne $actual) {
        "MISMATCH embeddedPartType in $($eml.Name): claims '$claimed', message has '$actual'"; $fail++
    }

    # extractionSource must agree with whether an embedded original exists.
    $expectSource = if ($e.classification -eq 'direct') { $null } elseif ($actual) { 'rfc822' } else { 'inline' }
    if ($e.extractionSource -ne $expectSource) {
        "MISMATCH extractionSource in $($eml.Name): claims '$($e.extractionSource)', implied '$expectSource'"; $fail++
    }
}

$emlCount = (Get-ChildItem (Join-Path $dir '*.eml')).Count
$jsonCount = (Get-ChildItem (Join-Path $dir '*.expected.json')).Count
"fixtures: $emlCount   sidecars: $jsonCount   failures: $fail"
