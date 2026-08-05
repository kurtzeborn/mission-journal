// Proves the Cloudflare sending credential works without putting a letter
// through ingest.
//
// This reads exactly the three settings the Function App reads and uses the
// same mailer, so a success here means the send path is sound and any later
// failure is in the letter, not the credential. That separation is the whole
// point: the first live claim email is not a good place to discover that a
// token was pasted wrong.
//
// The token is supplied out of band and never on the command line, because a
// command line is recorded in shell history and read by anything watching the
// terminal:
//
//   $env:CLOUDFLARE_ACCOUNT_ID = 'cfd16cf97da3b933b26c7e996d1c8433'
//   $env:CLOUDFLARE_API_TOKEN = az keyvault secret show --vault-name mj-kv-utfe5uagkbz7q --name cloudflare-api-token --query value -o tsv
//   $env:MAIL_ALLOWLIST = 'scott@kurtzeborn.org'
//   node tools/send-test-mail.js scott@kurtzeborn.org
//
// Exits non-zero on anything but a send, so it can gate a deployment.

import { createMailer } from '../src/lib/mail.js';

const to = process.argv[2];
if (!to) {
    console.error('usage: node tools/send-test-mail.js <recipient>');
    process.exit(1);
}

const mailer = createMailer({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    token: process.env.CLOUDFLARE_API_TOKEN ?? '',
    allowlist: process.env.MAIL_ALLOWLIST ?? ''
});

// `auto-generated` rather than `auto-replied`: RFC 3834 reserves that value
// for mail no incoming message provoked, which is precisely this.
//
// `MAIL_FROM` overrides the sending identity, because "can we send as this
// address" is a question about Cloudflare's configuration that no amount of
// reading the documentation settles as well as one send does.
const from = process.env.MAIL_FROM || 'post@pdayletters.com';
const result = await mailer.send({
    from,
    to,
    subject: 'pdayletters sending test',
    text: 'This is a test of the sending path. No letter was published and nothing was claimed.',
    html: '<p>This is a test of the sending path. No letter was published and nothing was claimed.</p>',
    headers: { 'Auto-Submitted': 'auto-generated' }
});

console.log(result);

// `process.exitCode` rather than `process.exit()`. Exiting outright while
// fetch still holds a keep-alive socket aborts the process on Windows with a
// libuv assertion, which reports a failure after a send has already
// succeeded -- the exact inversion this script exists to prevent. Setting the
// code lets Node close the socket and leave on its own, a few seconds later.
process.exitCode = result.status === 'sent' ? 0 : 1;
