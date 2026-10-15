// Remove the legacy digest entities after the compatibility release has
// backfilled and verified `digest-settings`.
//
// Dry-run by default:
//
//   node tools/cleanup-legacy-user-rows.js
//   node tools/cleanup-legacy-user-rows.js --apply

import { createTableStore } from '../src/lib/tables.js';
import { cleanupLegacyDigestRows } from '../src/lib/users.js';

const accountName = process.env.STORAGE_ACCOUNT_NAME ?? 'mjstutfe5uagkbz7q';
const apply = process.argv.includes('--apply');
const result = await cleanupLegacyDigestRows({
    tables: createTableStore({ accountName }),
    apply
});

console.log(JSON.stringify(result));
