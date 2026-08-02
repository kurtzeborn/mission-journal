# Throwaway verification of reset-slug.ps1 against real versioning +
# soft-delete semantics. Creates a fake slug, resets it, and reports what
# survives. Not part of the deployment path.
$ErrorActionPreference = 'Stop'
$acct = 'mjstutfe5uagkbz7q'
$slug = 'resetprobe'

function Show-State($label) {
    Write-Host "--- $label ---"
    foreach ($c in @('raw', 'rendered')) {
        $b = az storage blob list --account-name $acct --container-name $c `
            --prefix "$slug/" --include dv --auth-mode login `
            --query '[].{name:name, versionId:versionId, deleted:deleted}' `
            -o json --only-show-errors | ConvertFrom-Json
        if ($b) {
            foreach ($x in $b) {
                Write-Host ("  {0}/{1}  ver={2} deleted={3}" -f $c, $x.name, $x.versionId, $x.deleted)
            }
        }
        else { Write-Host "  ${c}: empty" }
    }
}

$tmp = New-TemporaryFile

# Two writes to the same name => two versions.
'v1' | Set-Content $tmp
az storage blob upload --account-name $acct --container-name raw --name "$slug/a.txt" `
    --file $tmp --auth-mode login --overwrite true --only-show-errors -o none
'v2' | Set-Content $tmp
az storage blob upload --account-name $acct --container-name raw --name "$slug/a.txt" `
    --file $tmp --auth-mode login --overwrite true --only-show-errors -o none

# One blob deleted the ordinary way => delete marker / soft-deleted state.
'gone' | Set-Content $tmp
az storage blob upload --account-name $acct --container-name raw --name "$slug/b.txt" `
    --file $tmp --auth-mode login --overwrite true --only-show-errors -o none
az storage blob delete --account-name $acct --container-name raw --name "$slug/b.txt" `
    --auth-mode login --only-show-errors -o none

'rendered' | Set-Content $tmp
az storage blob upload --account-name $acct --container-name rendered --name "$slug/posts.json" `
    --file $tmp --auth-mode login --overwrite true --only-show-errors -o none

Remove-Item $tmp -Force

Show-State 'before reset'
Write-Host ''
& "$PSScriptRoot/reset-slug.ps1" -Slug $slug -Confirm:$false
Write-Host ''
Show-State 'after reset'
