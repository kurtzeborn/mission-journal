// Backfill the compatibility release's `digest-settings` entities.
//
// Dry-run by default:
//
//   node tools/migrate-digest-settings.js
//   node tools/migrate-digest-settings.js --apply
//
// The old rows are deliberately retained. They are the rollback copy until a
// later release stops reading and writing them.

import { createTableStore } from '../src/lib/tables.js';
import { backfillDigestSettings } from '../src/lib/users.js';

const accountName = process.env.STORAGE_ACCOUNT_NAME ?? 'mjstutfe5uagkbz7q';
const apply = process.argv.includes('--apply');
const result = await backfillDigestSettings({
    tables: createTableStore({ accountName }),
    apply
});

console.log(JSON.stringify(result));
