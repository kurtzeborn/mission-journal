// Fails only on advisories we have not already looked at.
//
// `npm audit` scores the dependency tree, not the code path, and for a long
// while every finding against this package was against something `mailauth`
// pulled in and we never load. They were also all marked "No fix available", so
// a build that failed on them would have been permanently red, which is the
// reliable way to teach everyone to stop reading it.
//
// So this compares advisory IDs against `audit-baseline.json` rather than
// counting them. A count can stay the same while one advisory is fixed and
// another appears. An ID that is not in the baseline is new, and new is the
// only thing worth interrupting anyone for.
//
// The baseline is empty today and should be left that way where it can be:
// prefer the upgrade to the note explaining why the upgrade is not needed.
//
// To accept a new advisory, add its ID to the baseline **with a note saying why
// it is not reachable**. An entry without a reason is a silenced alarm.

import { readFileSync } from 'node:fs';

const baselinePath = new URL('../audit-baseline.json', import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const known = new Set(Object.keys(baseline.acknowledged));

// The report arrives on stdin -- `npm audit --json | node tools/audit-check.js`,
// which `npm run audit` wraps. Spawning npm from here is the obvious design and
// the wrong one on Windows: since the fix for CVE-2024-27980, Node refuses to
// execFile a `.cmd` without `shell: true`, and passing arguments *with*
// `shell: true` is itself deprecated for being unescaped. A pipe has neither
// problem and works identically on the runner.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
if (!raw.trim()) {
  console.error('no audit report on stdin -- run: npm audit --json | node tools/audit-check.js');
  process.exit(1);
}

const report = JSON.parse(raw);
const found = new Map();
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    // Strings in `via` are indirections to another package's finding, not
    // advisories in their own right.
    if (typeof via === 'string') continue;
    found.set(String(via.source), { name, title: via.title, severity: via.severity });
  }
}

const novel = [...found].filter(([id]) => !known.has(id));
const stale = [...known].filter((id) => !found.has(id));

console.log(`advisories: ${found.size} found, ${known.size} acknowledged`);

if (stale.length) {
  console.log(`\nno longer reported (safe to drop from the baseline): ${stale.join(', ')}`);
}

if (novel.length) {
  console.error(`\n${novel.length} advisory/advisories not in the baseline:\n`);
  for (const [id, v] of novel) {
    console.error(`  ${id}  ${v.severity.padEnd(8)} ${v.name} — ${v.title}`);
  }
  console.error('\nCheck whether the affected code is actually loaded. If it is not,');
  console.error('add the ID to functions/audit-baseline.json with the reason.');
  process.exit(1);
}

console.log('\nno new advisories');
