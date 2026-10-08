#!/usr/bin/env node
/**
 * Dependency-audit ratchet — ISO/IEC 27001 A.8.8.
 *
 * WHY A RATCHET AND NOT A THRESHOLD
 * At the moment this was written the tree carried 3 critical and 41 high
 * advisories across the manifests below. A gate that fails on "any high" would
 * therefore be red on every pull request from the day it lands, and a gate that
 * is always red gets switched off within a fortnight — leaving less coverage
 * than before it existed. A gate at "any critical" would have the same problem
 * for three of them and would say nothing about the other forty-one.
 *
 * So this compares against a COMMITTED BASELINE and fails when the count goes
 * UP. The debt cannot grow; Dependabot (.github/dependabot.yml) is what pays it
 * down, and every payment lowers the baseline. The baseline file is the honest
 * record of where the tree actually is — it is meant to be read, not hidden.
 *
 * WHAT IT COUNTS
 * `npm audit --omit=dev` where the manifest ships to customers, everything
 * where it does not. A dev-only advisory in the build tooling is real but it is
 * not the same finding as one in code that serves requests, and conflating them
 * is how the number stops meaning anything.
 *
 * WHICH ADVISORIES, NOT JUST HOW MANY
 * A count alone lets one high advisory be swapped for a different one unseen.
 * So the baseline also records the ids (GHSA) of the critical/high advisories
 * it carries, per target, and every id the audit reports today must be in that
 * record or in `accepted`, the per-advisory allowlist: `{ id }` or
 * `{ package, range }`, each with a `reason` and an `expires` date. An expired
 * entry accepts nothing. `--update` drops ids that were fixed and never adds
 * one — a new id is either fixed or accepted by hand, with the reason written
 * down.
 *
 * Run `node scripts/audit-ratchet.mjs --update` after fixing something to lower
 * the baseline. It never raises it: a bump has to be a deliberate edit with a
 * reason in the commit message, not a side effect of running the script.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, '.github/security/audit-baseline.json');

/**
 * The manifests this gate covers, and whether their dev dependencies count.
 *
 * `production: true` means the package ships to customers, so only runtime
 * dependencies are counted — a vulnerable test runner is not in the image.
 * `production: false` means the whole tree counts because the package IS
 * tooling; there is no runtime half to separate out.
 */
const TARGETS = process.argv.includes('--standalone-connector')
    ? [{ dir: '.', production: true, why: 'the extracted Nextcloud connector runtime' }]
    : [
    { dir: 'server', production: true, why: 'the API — every request goes through it' },
    { dir: 'agent-hub', production: true, why: 'the SPA served to every user' },
    { dir: 'nextcloud-connector', production: true, why: 'holds the tenant signing key' },
    { dir: 'desktop', production: true, why: 'runs on the user\'s own machine, outside any sandbox we control' },
    { dir: '.', production: false, why: 'root dev tooling — dev:all, build scripts' },
];

const LEVELS = ['critical', 'high'];

function audit(dir, production) {
    // --package-lock-only: audit the LOCKFILE tree, never whatever happens to
    // be sitting in node_modules. The lockfile is what resolves the tree and
    // what ships; an installed node_modules is only a materialisation of it.
    // Stating it explicitly makes the result identical in CI (no node_modules,
    // since dependency-audit.yml stopped installing five trees) and on a
    // developer machine with a stale one — and it is what lets that workflow
    // not install them. Order matters to nobody but the reader: --omit=dev
    // below is a separate axis, see WHAT IT COUNTS above.
    const args = ['audit', '--json', '--package-lock-only'];
    if (production) args.push('--omit=dev');
    let out;
    try {
        out = execFileSync('npm', args, { cwd: path.join(ROOT, dir), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        // npm audit exits non-zero WHEN IT FINDS SOMETHING. That is the normal
        // case here, so the output on stdout is the result, not an error. A
        // genuine failure has no parseable body and is re-thrown below.
        out = e.stdout;
    }
    if (!out) throw new Error(`npm audit produced no output in ${dir} — is package-lock.json present and readable?`);
    const parsed = JSON.parse(out);
    if (parsed.error || !parsed.metadata?.vulnerabilities || !parsed.vulnerabilities) throw new Error(`Dependency audit failed in ${dir}`);
    const v = parsed.metadata.vulnerabilities;
    return {
        counts: Object.fromEntries(LEVELS.map((l) => [l, Number(v[l]) || 0])),
        advisories: advisoriesOf(parsed),
    };
}

/**
 * The distinct critical/high advisories in an `npm audit --json` report.
 * Each vulnerable package lists its causes under `via`; the objects there are
 * advisories (a string is a reference to another vulnerable package). The id
 * is the GHSA from the advisory url, with npm's numeric `source` as fallback.
 */
function advisoriesOf(parsed) {
    const byId = new Map();
    for (const entry of Object.values(parsed.vulnerabilities || {})) {
        for (const via of entry.via || []) {
            if (!via || typeof via !== 'object' || !LEVELS.includes(via.severity)) continue;
            const id = String(via.url || '').match(/(GHSA-[0-9a-z-]+)$/)?.[1] || String(via.source);
            if (!byId.has(id)) byId.set(id, { id, package: via.name, range: via.range, severity: via.severity, title: via.title });
        }
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function readBaseline() {
    if (!fs.existsSync(BASELINE)) return null;
    return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with the hand-written allowlist; a malformed entry must not accept anything silently. */
function allowlistErrors(accepted) {
    if (accepted === undefined) return [];
    if (!Array.isArray(accepted)) return ['`accepted` must be an array'];
    return accepted.flatMap((a, i) => {
        const where = `accepted[${i}]`;
        const errs = [];
        if (!a || typeof a !== 'object') return [`${where}: not an object`];
        if (typeof a.id !== 'string' && typeof a.package !== 'string') errs.push(`${where}: needs an \`id\` or a \`package\``);
        if (typeof a.reason !== 'string' || !a.reason.trim()) errs.push(`${where}: needs a \`reason\``);
        if (typeof a.expires !== 'string' || !DATE.test(a.expires) || Number.isNaN(Date.parse(a.expires))) errs.push(`${where}: needs an \`expires\` date as YYYY-MM-DD`);
        return errs;
    });
}

function acceptedEntryFor(accepted, adv) {
    return (accepted || []).find((a) => (a.id ? a.id === adv.id : a.package === adv.package && (!a.range || a.range === adv.range)));
}

const update = process.argv.includes('--update');
const release = process.argv.includes('--release');
if (release && update) throw new Error('--release cannot update or create an approval baseline');
const today = new Date().toISOString().slice(0, 10);
const measured = {};
for (const t of TARGETS) {
    measured[t.dir] = { ...audit(t.dir, t.production), production: t.production };
}

const baseline = readBaseline();

if (release && !baseline) throw new Error('Release audit requires a reviewed baseline and explicit exceptions');
if (update || !baseline) {
    const next = {
        _comment: 'Highest counts this repository is allowed to carry, and the critical/high advisory ids it carries per target. Lower both by fixing advisories and re-running `node scripts/audit-ratchet.mjs --update`; raising a count or adding an id is a deliberate edit that belongs in a commit message with a reason. A new advisory that cannot be fixed yet goes in `accepted` as { id } or { package, range } with a reason and an expires date (YYYY-MM-DD).',
        _generated: today,
        targets: Object.fromEntries(TARGETS.map((t) => [t.dir, { why: t.why, production: t.production }])),
        counts: Object.fromEntries(Object.entries(measured).map(([d, m]) => [d, { critical: m.counts.critical, high: m.counts.high }])),
        advisories: Object.fromEntries(Object.entries(measured).map(([d, m]) => [d, m.advisories.map((a) => a.id)])),
        accepted: baseline?.accepted || [],
    };
    // Never raise on --update: a regression must fail the gate, not quietly
    // become the new normal because somebody ran the updater. Same for ids: a
    // recorded set only ever shrinks; the first record of a target is taken whole.
    if (baseline) {
        for (const [dir, c] of Object.entries(next.counts)) {
            const was = baseline.counts?.[dir];
            if (!was) continue;
            c.critical = Math.min(c.critical, was.critical);
            c.high = Math.min(c.high, was.high);
        }
        for (const [dir, ids] of Object.entries(next.advisories)) {
            const was = baseline.advisories?.[dir];
            if (Array.isArray(was)) next.advisories[dir] = ids.filter((id) => was.includes(id));
        }
    }
    fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Baseline written to ${path.relative(ROOT, BASELINE)}`);
    for (const [dir, c] of Object.entries(next.counts)) console.log(`  ${dir}: ${c.critical} critical, ${c.high} high, ${next.advisories[dir].length} advisories recorded`);
    process.exit(0);
}

let failed = false;
const lines = [];
const listErrors = allowlistErrors(baseline.accepted);
if (listErrors.length > 0) {
    failed = true;
    lines.push(...listErrors.map((e) => `❌ audit-baseline.json: ${e}`));
}
const accepted = listErrors.length > 0 ? [] : (baseline.accepted || []);

for (const t of TARGETS) {
    const now = measured[t.dir];
    const was = baseline.counts?.[t.dir];
    if (!was) {
        lines.push(`❓ ${t.dir}: no baseline entry — run \`node scripts/audit-ratchet.mjs --update\``);
        failed = true;
        continue;
    }
    const scope = t.production ? 'runtime deps' : 'all deps';
    const over = LEVELS.filter((l) => now.counts[l] > was[l]);
    if (over.length > 0) {
        failed = true;
        lines.push(`❌ ${t.dir} (${scope}): ` + over.map((l) => `${l} ${was[l]} → ${now.counts[l]}`).join(', '));
    } else if (LEVELS.some((l) => now.counts[l] < was[l])) {
        lines.push(`✅ ${t.dir} (${scope}): improved — ${LEVELS.map((l) => `${l} ${was[l]} → ${now.counts[l]}`).join(', ')}. Run with --update to lower the baseline.`);
    } else {
        lines.push(`➖ ${t.dir} (${scope}): unchanged — ${now.counts.critical} critical, ${now.counts.high} high`);
    }

    if (release && LEVELS.some(level => now.counts[level] > 0) && now.advisories.length === 0) {
        failed = true;
        lines.push(`❌ ${t.dir}: audit reports high/critical vulnerabilities without identifiable advisories`);
    }
    const recorded = new Set(baseline.advisories?.[t.dir] || []);
    for (const adv of now.advisories) {
        if (!release && recorded.has(adv.id)) continue;
        const entry = acceptedEntryFor(accepted, adv);
        const label = `${adv.id} (${adv.severity}) in ${adv.package}${adv.range ? ' ' + adv.range : ''}: ${adv.title}`;
        if (entry && entry.expires >= today && (!release || (typeof entry.reachability === 'string' && entry.reachability.trim() && typeof entry.reviewedAt === 'string' && DATE.test(entry.reviewedAt) && entry.reviewedAt <= today))) {
            lines.push(`➖ ${t.dir}: ${adv.id} accepted until ${entry.expires} — ${entry.reason}`);
        } else if (entry && entry.expires >= today) {
            failed = true;
            lines.push(`❌ ${t.dir}: release exception for ${adv.id} lacks a dated reachability review`);
        } else if (entry) {
            failed = true;
            lines.push(`❌ ${t.dir}: allowlist entry for ${adv.id} expired on ${entry.expires} — ${label}`);
        } else {
            failed = true;
            lines.push(`❌ ${t.dir}: new advisory ${label}`);
        }
    }
    const gone = [...recorded].filter((id) => !now.advisories.some((a) => a.id === id));
    if (gone.length > 0) {
        lines.push(`✅ ${t.dir}: ${gone.length} recorded advisor${gone.length === 1 ? 'y is' : 'ies are'} gone. Run with --update to drop them from the baseline.`);
    }
}

console.log(lines.join('\n'));
if (failed) {
    console.error('\nThis change adds high or critical advisories, or advisories the baseline does not know. Either pick a version without them, or — if the dependency is unavoidable and the advisory does not apply to how it is used — accept the id in .github/security/audit-baseline.json with a reason and an expiry, in the same commit.');
    process.exit(1);
}
