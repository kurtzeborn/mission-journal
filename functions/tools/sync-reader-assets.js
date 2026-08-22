// Copy the site's reader files into the Function App's asset folder.
//
// The downloaded archive contains the site's own reader, and "the site's own"
// has to be literally true or the offline copy quietly becomes a second
// implementation. It cannot be a shared import: the two are packaged by
// different deployments, and `func publish` cannot reach outside functions/.
//
// So there are two copies and a rule -- web/ is authoritative, this script
// makes the other match, and archive.test.js fails the build if they ever
// differ. Run it after touching any of the files below.
//
//   node tools/sync-reader-assets.js

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

export const SHARED_READER_FILES = [
    { from: join('web', 'reader.js'), to: 'reader.js' },
    { from: join('web', 'styles.css'), to: 'styles.css' },
    { from: join('web', 'logo.png'), to: 'logo.png' },
    { from: join('web', 'vendor', 'minisearch.js'), to: 'minisearch.js' },
    { from: join('web', 'vendor', 'wordcloud2.js'), to: 'wordcloud2.js' }
];

export const ASSET_DIR = join(here, '..', 'src', 'assets', 'reader');
export const WEB_DIR = repo;

mkdirSync(ASSET_DIR, { recursive: true });

for (const file of SHARED_READER_FILES) {
    copyFileSync(join(repo, file.from), join(ASSET_DIR, file.to));
    console.log(`${file.from} -> src/assets/reader/${file.to}`);
}
