// Rebuild the memberships index from the ACLs, which are the authority.
//
// `memberships` is a derived index. It can be wrong -- a failed write, a
// hand-edited ACL, a site provisioned before the index existed -- and none of
// those should need anybody to reason about which rows are missing. This
// reconstructs it from `config/*/acl.json`, which is the only thing that
// actually decides who may read a site.
//
// Run it for one slug, or for all of them:
//
//   node tools/rebuild-memberships.js
//   node tools/rebuild-memberships.js isaac.backman
//
// Safe to run at any time. It is upsert-and-prune, not delete-and-recreate,
// so it never leaves a window in which somebody's archive is missing from
// their list.

import { createBlobStore } from '../src/lib/store.js';
import { createTableStore } from '../src/lib/tables.js';
import { rebuildMemberships } from '../src/lib/memberships.js';
import { touchSiteActivity, setSiteName } from '../src/lib/sites.js';

const accountName = process.env.STORAGE_ACCOUNT_NAME ?? 'mjstutfe5uagkbz7q';

const blobs = createBlobStore({ accountName });
const tables = createTableStore({ accountName });

const wanted = process.argv[2];

const slugsFromConfig = async () => {
    const names = await blobs.listBlobs('config', '');
    return [...new Set(names.filter((n) => n.endsWith('/acl.json')).map((n) => n.split('/')[0]))];
};

const newestPostDate = async (slug) => {
    const blob = await blobs.readBlob('rendered', `${slug}/posts.json`);
    if (!blob) return '';
    const posts = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    return posts.reduce((latest, post) => {
        const stamp = String(post.originalDate ?? '');
        return stamp > latest ? stamp : latest;
    }, '');
};

const slugs = wanted ? [wanted] : await slugsFromConfig();
if (slugs.length === 0) {
    console.log('no ACLs found; nothing to rebuild');
    process.exit(0);
}

for (const slug of slugs) {
    const blob = await blobs.readBlob('config', `${slug}/acl.json`);
    if (!blob) {
        console.log(`${slug}: no acl.json, skipped`);
        continue;
    }

    const acl = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    const lastPostAt = await newestPostDate(slug);

    await rebuildMemberships({ tables, slug, acl });
    await touchSiteActivity({ tables, slug, lastPostAt });

    // `profile.json` is the record and the `sites` row is the index, the same
    // way `acl.json` is the record behind `memberships`. Restoring the name
    // from the file is the whole point of running this: the row is the copy
    // that can be lost.
    //
    // Skipped entirely when there is no file, which is the case for every site
    // claimed before profile editing existed. Those have a name on the row and
    // nothing to restore it from, and overwriting it with a blank would turn a
    // repair into a data loss.
    const profileBlob = await blobs.readBlob('config', `${slug}/profile.json`);
    if (profileBlob) {
        const profile = JSON.parse(Buffer.from(profileBlob.bytes).toString('utf8'));
        await setSiteName({ tables, slug, missionaryDisplayName: profile.displayName ?? '' });
    }

    console.log(`${slug}: ${acl.members?.length ?? 0} member(s), lastPostAt=${lastPostAt || 'none'}`);
}
