#Requires -Version 7.0
<#
    One line of health for a live archive: how many raw messages have arrived,
    how many of them have been rendered, and which are still in flight.

    posts.json is fetched to a temporary file rather than into the working tree.
    It holds real letters and this repository is public, so a copy sitting beside
    the code is one `git add -A` away from being published.
#>
param(
    [string]$Slug = 'isaac.backman',
    [string]$Account = 'mjstutfe5uagkbz7q',
    [string]$Subscription = '41fbccc1-bb65-416d-816d-30cb2a41dd9b'
)

$postsFile = Join-Path ([IO.Path]::GetTempPath()) "mj-posts-$([guid]::NewGuid()).json"

try {
    $raw = (az storage blob list --container-name raw --prefix "$Slug/" --account-name $Account --auth-mode login --subscription $Subscription --num-results '*' -o json 2>$null | ConvertFrom-Json).name |
        ForEach-Object { ($_ -split '/')[1] } | Sort-Object -Unique

    az storage blob download --container-name rendered --name "$Slug/posts.json" --file $postsFile --account-name $Account --auth-mode login --subscription $Subscription --overwrite -o none 2>$null
    $posts = Get-Content $postsFile -Raw | ConvertFrom-Json

    $photos = (az storage blob list --container-name rendered --prefix "$Slug/photos/" --account-name $Account --auth-mode login --subscription $Subscription --num-results '*' -o json 2>$null | ConvertFrom-Json).Count
    $inbox = (az storage blob list --container-name inbox --account-name $Account --auth-mode login --subscription $Subscription --num-results '*' -o json 2>$null | ConvertFrom-Json).Count

    $held = @($posts | Where-Object { $_.heldReason }).Count
    $hidden = @($posts | Where-Object { $_.hidden }).Count
    $noBody = @($posts | Where-Object { -not $_.bodyHtml }).Count

    "{0}  raw={1} posts={2} gap={3} | photos={4} inbox={5} | held={6} hidden={7} emptyBody={8}" -f `
    (Get-Date -Format HH:mm:ss), $raw.Count, $posts.Count, ($raw.Count - $posts.Count), $photos, $inbox, $held, $hidden, $noBody

    # A raw folder whose ULID never turned up in posts.json is in flight or stuck.
    $done = $posts | ForEach-Object { ($_.sourceRawPath -split '/')[2] }
    $stuck = $raw | Where-Object { $done -notcontains $_ }
    if ($stuck) { "  awaiting render ($($stuck.Count)): $(($stuck | Select-Object -First 6) -join ', ')" }
}
finally {
    Remove-Item $postsFile -ErrorAction SilentlyContinue
}
