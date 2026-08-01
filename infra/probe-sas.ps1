$ErrorActionPreference = 'Continue'
$acct = 'mjstutfe5uagkbz7q'
$key = az storage account keys list --account-name $acct --resource-group mission-journal --subscription 41fbccc1-bb65-416d-816d-30cb2a41dd9b --query '[0].value' -o tsv
$blobSas = az storage container generate-sas --name inbox --policy-name worker-write --https-only --account-name $acct --account-key $key -o tsv
$queueSas = az storage queue generate-sas --name ingest --policy-name worker-add --https-only --account-name $acct --account-key $key -o tsv 2>$null

function Probe($label, $method, $url, $headers, $body) {
    try {
        $p = @{ Uri = $url; Method = $method; TimeoutSec = 20; UseBasicParsing = $true }
        if ($headers) { $p.Headers = $headers }
        if ($body) { $p.Body = $body }
        $r = Invoke-WebRequest @p
        "{0,-22} {1}  ALLOWED" -f $label, $r.StatusCode
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        "{0,-22} {1}  denied" -f $label, $code
    }
}

$blob = "https://$acct.blob.core.windows.net/inbox"
$raw = "https://$acct.blob.core.windows.net/raw"
$queue = "https://$acct.queue.core.windows.net/ingest"

'--- blob SAS (expect: write only) ---'
Probe 'write inbox blob' 'PUT' "$blob/sas-probe.raw?$blobSas" @{'x-ms-blob-type' = 'BlockBlob' } 'probe'
Probe 'read inbox blob' 'GET' "$blob/sas-probe.raw?$blobSas" $null $null
Probe 'list inbox' 'GET' "$blob`?restype=container&comp=list&$blobSas" $null $null
Probe 'delete inbox blob' 'DELETE' "$blob/sas-probe.raw?$blobSas" $null $null
Probe 'write to raw' 'PUT' "$raw/sas-probe.raw?$blobSas" @{'x-ms-blob-type' = 'BlockBlob' } 'probe'

'--- queue SAS (expect: add only) ---'
Probe 'enqueue message' 'POST' "$queue/messages?$queueSas" $null '<QueueMessage><MessageText>probe</MessageText></QueueMessage>'
Probe 'peek messages' 'GET' "$queue/messages?peekonly=true&$queueSas" $null $null
