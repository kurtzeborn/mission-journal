#Requires -Version 7.0
<#
.SYNOPSIS
    Rewrites identifying strings inside .eml fixtures — including strings that
    a text editor cannot see.

.DESCRIPTION
    Captured forwards do not keep the quoted original in plain text. Verified
    against real Outlook captures in Phase 0:

      * Outlook desktop base64-encodes the whole forwarded block, so the
        original From/To/Cc are invisible to a find/replace and to grep. They
        are still trivially decodable, so leaving them is not an option.
      * Outlook web uses quoted-printable and splits long strings across `=`
        soft line breaks mid-address (`elder=` / `.example@missionary.org`), so
        a literal search misses them.
      * Charsets differ per client (utf-8 vs Windows-1252) and headers may hide
        text inside RFC 2047 encoded-words.

    This script walks each MIME part, decodes it, applies the replacements, and
    re-encodes in the part's original transfer encoding. Binary parts (images)
    are passed through untouched.

    Everything is handled as Latin-1 (byte-preserving) rather than a real
    charset decode. All replacement terms are ASCII, so non-ASCII bytes survive
    the round trip unexamined and no charset table is needed.

    Re-encoding changes line wrapping. That is harmless: MIME boundaries are not
    length-prefixed and email has no Content-Length. It does invalidate DKIM
    signatures on the rewritten parts, which does not matter — DMARC is
    evaluated at Cloudflare before the ingest Function sees the message, and the
    Function reads Authentication-Results as text.

.PARAMETER Map
    Ordered hashtable of literal find -> replace pairs, applied in order.

    Pass real values on the command line. Do NOT add defaults to this file and
    do not commit a map containing real addresses — removing them from the repo
    is the entire point of the script.

.PARAMETER Path
    Directory of .eml files. Defaults to tests/fixtures.

.PARAMETER Check
    Report residue only; make no changes. Decodes every part, so it finds
    matches that grep cannot.

.EXAMPLE
    ./tools/scrub-fixtures.ps1 -Check -Map ([ordered]@{ 'real@example.com' = '' })

.EXAMPLE
    ./tools/scrub-fixtures.ps1 -Map ([ordered]@{
        'real.person@example.com' = 'elder.example@missionary.org'
        'Real Person'             = 'Elder Example'
    })
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [System.Collections.IDictionary]$Map,

    [string]$Path = (Join-Path $PSScriptRoot '..' 'tests' 'fixtures'),

    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Latin-1 maps bytes 0-255 one-to-one onto chars, so string round-trips are
# lossless. Every other encoding would mangle bytes it cannot interpret.
$script:Latin1 = [System.Text.Encoding]::GetEncoding(28591)

function Convert-Literal {
    param([string]$Text)
    foreach ($k in $Map.Keys) {
        # .Replace is ordinal and literal — no regex escaping to get wrong.
        $Text = $Text.Replace($k, [string]$Map[$k])
    }
    return $Text
}

function Test-Literal {
    param([string]$Text)
    foreach ($k in $Map.Keys) {
        if ($Text.Contains($k)) { return $true }
    }
    return $false
}

function ConvertFrom-Qp {
    param([string]$Text)
    # Soft line breaks first: they can split a token anywhere, including
    # mid-address, which is what defeats a plain search.
    $t = $Text -replace "=\r?\n", ''
    $out = [System.Collections.Generic.List[byte]]::new()
    $i = 0
    while ($i -lt $t.Length) {
        $c = $t[$i]
        if ($c -eq '=' -and ($i + 2) -lt $t.Length) {
            $hex = $t.Substring($i + 1, 2)
            $b = 0
            if ([byte]::TryParse($hex, [System.Globalization.NumberStyles]::HexNumber, $null, [ref]$b)) {
                $out.Add($b); $i += 3; continue
            }
        }
        $out.Add([byte][int]$c); $i++
    }
    return $out.ToArray()
}

function ConvertTo-Qp {
    param([byte[]]$Bytes)
    $sb = [System.Text.StringBuilder]::new()
    $lineLen = 0
    $pending = -1   # whitespace held back, in case it lands at end of line

    # Wrapping is inlined rather than factored into a helper: a nested function
    # assigning to $lineLen would silently get its own copy and never wrap.
    for ($i = 0; $i -lt $Bytes.Length; $i++) {
        $b = $Bytes[$i]

        # Hard line break: preserve as a real CRLF.
        if ($b -eq 13 -and ($i + 1) -lt $Bytes.Length -and $Bytes[$i + 1] -eq 10) {
            if ($pending -ge 0) {
                $c = '=' + ('{0:X2}' -f $pending)
                if (($lineLen + 3) -gt 75) { [void]$sb.Append("=`r`n"); $lineLen = 0 }
                [void]$sb.Append($c); $lineLen += 3; $pending = -1
            }
            [void]$sb.Append("`r`n"); $lineLen = 0; $i++
            continue
        }
        if ($b -eq 10) {
            if ($pending -ge 0) {
                $c = '=' + ('{0:X2}' -f $pending)
                if (($lineLen + 3) -gt 75) { [void]$sb.Append("=`r`n"); $lineLen = 0 }
                [void]$sb.Append($c); $lineLen += 3; $pending = -1
            }
            [void]$sb.Append("`r`n"); $lineLen = 0
            continue
        }

        if ($pending -ge 0) {
            $c = [string][char]$pending
            if (($lineLen + 1) -gt 75) { [void]$sb.Append("=`r`n"); $lineLen = 0 }
            [void]$sb.Append($c); $lineLen += 1; $pending = -1
        }

        if ($b -eq 32 -or $b -eq 9) {
            # Trailing whitespace must be encoded, so decide once we know what
            # follows.
            $pending = $b
            continue
        }

        $chunk = if ($b -eq 61) { '=3D' }
        elseif ($b -ge 33 -and $b -le 126) { [string][char]$b }
        else { '=' + ('{0:X2}' -f $b) }

        if (($lineLen + $chunk.Length) -gt 75) { [void]$sb.Append("=`r`n"); $lineLen = 0 }
        [void]$sb.Append($chunk); $lineLen += $chunk.Length
    }
    if ($pending -ge 0) {
        $c = '=' + ('{0:X2}' -f $pending)
        if (($lineLen + 3) -gt 75) { [void]$sb.Append("=`r`n"); $lineLen = 0 }
        [void]$sb.Append($c)
    }

    return $sb.ToString()
}

function ConvertTo-Base64Lines {
    param([byte[]]$Bytes)
    $b64 = [Convert]::ToBase64String($Bytes)
    $sb = [System.Text.StringBuilder]::new()
    for ($i = 0; $i -lt $b64.Length; $i += 76) {
        $len = [Math]::Min(76, $b64.Length - $i)
        [void]$sb.Append($b64.Substring($i, $len)).Append("`r`n")
    }
    return $sb.ToString()
}

function Convert-EncodedWords {
    param([string]$Text)
    return [regex]::Replace($Text, '=\?([^?]+)\?([BbQq])\?([^?]*)\?=', {
        param($m)
        $charset = $m.Groups[1].Value
        $scheme = $m.Groups[2].Value.ToUpperInvariant()
        $data = $m.Groups[3].Value
        try {
            $bytes = if ($scheme -eq 'B') {
                [Convert]::FromBase64String($data)
            } else {
                ConvertFrom-Qp ($data -replace '_', ' ')
            }
        } catch { return $m.Value }

        $decoded = $script:Latin1.GetString($bytes)
        $replaced = Convert-Literal $decoded
        if ($replaced -eq $decoded) { return $m.Value }

        $nb = $script:Latin1.GetBytes($replaced)
        if ($scheme -eq 'B') {
            # Braced. `?` is legal in a PowerShell variable name, so "=?$charset?B?"
            # asks for a variable called `charset?B?` and throws.
            return "=?${charset}?B?" + [Convert]::ToBase64String($nb) + '?='
        }
        # Encoded-word Q is stricter than body quoted-printable: space becomes
        # '_' and '?' '_' '=' must be encoded.
        $sb = [System.Text.StringBuilder]::new()
        foreach ($b in $nb) {
            if ($b -eq 32) { [void]$sb.Append('_') }
            elseif ($b -ge 33 -and $b -le 126 -and $b -ne 61 -and $b -ne 63 -and $b -ne 95) {
                [void]$sb.Append([char]$b)
            }
            else { [void]$sb.Append('=' + ('{0:X2}' -f $b)) }
        }
        return "=?${charset}?Q?" + $sb.ToString() + '?='
    })
}

function Get-PartHeaderValue {
    param([string[]]$HeaderLines, [string]$Name)
    # Unfold: a continuation line starts with whitespace.
    $unfolded = @()
    foreach ($line in $HeaderLines) {
        if ($line -match '^[ \t]' -and $unfolded.Count -gt 0) {
            $unfolded[-1] += ' ' + $line.TrimStart()
        } else {
            $unfolded += $line
        }
    }
    foreach ($line in $unfolded) {
        if ($line -match "^$([regex]::Escape($Name))\s*:\s*(.*)$") {
            return $Matches[1].Trim()
        }
    }
    return $null
}

function Convert-Message {
    <#
        Walks the raw message line by line, tracking MIME boundaries so each
        part's body can be decoded with the right transfer encoding.

        Boundaries are collected up front from every `boundary=` declaration in
        the file. That covers nested multiparts and the inner message of a
        message/rfc822 part without recursion: the inner headers arrive as the
        body of a 7bit part and are rewritten literally, and the inner
        boundaries are already in the set.

        A base64-encoded embedded message is the exception. Outlook Android
        labels its forward-as-attachment payload application/octet-stream and
        base64-encodes the whole original, so none of that message's own parts
        or boundaries appear in the file and the walk cannot see them. Those
        payloads are decoded and passed back through this function.
    #>
    param([string]$Raw, [ref]$Found)

    $boundaries = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($m in [regex]::Matches($Raw, '(?i)boundary\s*=\s*"?([^";\r\n]+)"?')) {
        [void]$boundaries.Add($m.Groups[1].Value.Trim())
    }

    # No max-substrings argument. `-split "`r`n", -1` does NOT mean "unlimited":
    # a negative count splits from the right, and -1 returns a single substring,
    # i.e. the whole message unsplit. Every part then looks like one giant header
    # block, nothing gets decoded, and the script degrades to a find/replace
    # without failing.
    $lines = $Raw -split "`r`n"
    $out = [System.Text.StringBuilder]::new()

    $mode = 'header'
    $headerLines = [System.Collections.Generic.List[string]]::new()
    $bodyLines = [System.Collections.Generic.List[string]]::new()
    $cte = $null
    $ctype = $null

    # Both flush steps are inlined via scriptblocks invoked with the dot
    # operator, which runs them in the caller's scope. A nested function would
    # get private copies of $cte / $ctype / $mode and quietly do nothing.

    $flushBody = {
        if ($bodyLines.Count -gt 0) {
            $body = ($bodyLines -join "`r`n")
            $handled = $false

            $isText = (-not $ctype) -or ($ctype -match '(?i)^\s*(text/|message/)')
            $isOpaque = $ctype -match '(?i)^\s*application/octet-stream'
            $enc = if ($cte) { $cte.ToLowerInvariant() } else { '' }

            if (($isText -or $isOpaque) -and $enc -eq 'base64') {
                $b64 = ($body -replace '\s', '')
                if ($b64) {
                    # Only the decode is guarded. Wrapping the replace and
                    # re-encode in the same try would let a real bug in them be
                    # swallowed and reported as clean.
                    $bytes = $null
                    try { $bytes = [Convert]::FromBase64String($b64) }
                    catch [System.FormatException] { $bytes = $null }

                    if ($null -ne $bytes) {
                        $decoded = $script:Latin1.GetString($bytes)
                        if ($decoded -match '^[A-Za-z][A-Za-z0-9-]*:\s') {
                            # An embedded message: walk it as one, so its own
                            # quoted-printable and base64 parts get decoded too.
                            # A literal replace over the flat text would miss any
                            # address split across a soft line break.
                            $replaced = Convert-Message -Raw $decoded -Found $Found
                        }
                        else {
                            if (Test-Literal $decoded) { $Found.Value = $true }
                            $replaced = Convert-Literal $decoded
                        }
                        if ($replaced -ne $decoded) {
                            [void]$out.Append((ConvertTo-Base64Lines $script:Latin1.GetBytes($replaced)))
                            $handled = $true
                        }
                    }
                }
            }
            elseif ($isText -and $enc -eq 'quoted-printable') {
                $bytes = ConvertFrom-Qp $body
                $decoded = $script:Latin1.GetString($bytes)
                if (Test-Literal $decoded) { $Found.Value = $true }
                $replaced = Convert-Literal $decoded
                if ($replaced -ne $decoded) {
                    [void]$out.Append((ConvertTo-Qp $script:Latin1.GetBytes($replaced))).Append("`r`n")
                    $handled = $true
                }
            }
            elseif ($isText) {
                if (Test-Literal $body) { $Found.Value = $true }
                $body = Convert-Literal $body
            }

            if (-not $handled) { [void]$out.Append($body).Append("`r`n") }
            $bodyLines.Clear()
        }
    }

    $flushHeaders = {
        if ($headerLines.Count -gt 0) {
            $block = ($headerLines -join "`r`n")
            if (Test-Literal $block) { $Found.Value = $true }
            $block = Convert-EncodedWords $block
            $block = Convert-Literal $block
            [void]$out.Append($block).Append("`r`n")
            $cte = Get-PartHeaderValue $headerLines 'Content-Transfer-Encoding'
            $ctype = Get-PartHeaderValue $headerLines 'Content-Type'
            $headerLines.Clear()
        }
    }

    foreach ($line in $lines) {
        $isBoundary = $false
        if ($line.StartsWith('--')) {
            $candidate = $line.Substring(2).TrimEnd('-').TrimEnd()
            if ($boundaries.Contains($candidate)) { $isBoundary = $true }
        }

        if ($isBoundary) {
            if ($mode -eq 'header') { . $flushHeaders } else { . $flushBody }
            [void]$out.Append($line).Append("`r`n")
            $mode = 'header'
            $cte = $null
            $ctype = $null
            continue
        }

        if ($mode -eq 'header') {
            if ($line -eq '') {
                . $flushHeaders
                [void]$out.Append("`r`n")
                $mode = 'body'
            } else {
                $headerLines.Add($line)
            }
        } else {
            $bodyLines.Add($line)
        }
    }

    if ($mode -eq 'header') { . $flushHeaders } else { . $flushBody }

    # The split/rejoin adds one trailing CRLF per flush; trim back to the
    # original tail so byte counts stay comparable.
    return ($out.ToString() -replace "(`r`n)+$", "`r`n")
}

# ---------------------------------------------------------------------------

$dir = Resolve-Path -LiteralPath $Path
# Wrapped, because a directory holding exactly one capture makes Get-ChildItem
# return a bare FileInfo, which has no .Count and takes the whole run down.
$files = @(Get-ChildItem -LiteralPath $dir -Filter *.eml)
if (-not $files) {
    Write-Warning "No .eml files under $dir"
    return
}

Write-Host ""
Write-Host ("{0} {1} fixture(s) in {2}" -f ($(if ($Check) { 'Checking' } else { 'Scrubbing' })), $files.Count, $dir)
Write-Host ""

$anyResidue = $false

foreach ($file in $files) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $raw = $script:Latin1.GetString($bytes)

    # Normalize to CRLF so boundary and header detection is uniform. Downloads
    # from webmail are already CRLF; a git checkout may not be.
    if ($raw -notmatch "`r`n") { $raw = $raw -replace "`n", "`r`n" }

    $found = $false
    $result = Convert-Message -Raw $raw -Found ([ref]$found)

    if ($Check) {
        if ($found) {
            $anyResidue = $true
            Write-Host ("  RESIDUE  {0}" -f $file.Name) -ForegroundColor Red
        } else {
            Write-Host ("  clean    {0}" -f $file.Name) -ForegroundColor Green
        }
        continue
    }

    if (-not $found) {
        Write-Host ("  no match {0}" -f $file.Name)
        continue
    }

    if ($PSCmdlet.ShouldProcess($file.Name, 'Rewrite identifying strings')) {
        [System.IO.File]::WriteAllBytes($file.FullName, $script:Latin1.GetBytes($result))
        Write-Host ("  scrubbed {0}" -f $file.Name) -ForegroundColor Green
    }
}

if ($Check -and $anyResidue) {
    Write-Host ""
    Write-Host "Residue found. Run without -Check to rewrite." -ForegroundColor Yellow
}

Write-Host ""
