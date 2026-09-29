/**
 * The ratchet is a gate, so the thing worth testing is that it REFUSES.
 *
 * A gate that only ever passes is indistinguishable from no gate, and this one
 * is easy to get subtly wrong in the passing direction: npm audit exits
 * non-zero when it finds something, so a naive implementation treats every
 * result as an error and silently reports nothing.
 *
 * These tests drive the script with a fake `npm` on PATH, so they exercise the
 * real comparison and the real exit codes without a network or a lockfile.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'audit-ratchet.mjs');

/**
 * A throwaway repository: the script's own directories, a baseline, and a fake
 * `npm` that reports whatever counts and advisories the test asks for and
 * exits 1 the way the real one does when it finds something.
 */
function sandbox({ counts, baseline, npmExit = 1, advisories = {} }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));
    fs.mkdirSync(path.join(dir, '.github/security'), { recursive: true });
    for (const d of ['server', 'agent-hub', 'nextcloud-connector', 'desktop']) {
        fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/audit-ratchet.mjs'));
    if (baseline) {
        fs.writeFileSync(path.join(dir, '.github/security/audit-baseline.json'), JSON.stringify(baseline, null, 2));
    }

    // Fake npm: prints the counts and advisories for the directory it was run
    // in, in the shape of `npm audit --json` (auditReportVersion 2).
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const rel = path.relative(${JSON.stringify(dir)}, process.cwd()) || '.';
fs.appendFileSync(path.join(${JSON.stringify(dir)}, 'npm-calls.log'), JSON.stringify({ dir: rel, argv: process.argv.slice(2) }) + '\\n');
const counts = ${JSON.stringify(counts)};
const c = counts[rel] || { critical: 0, high: 0 };
const advisories = ${JSON.stringify(advisories)};
const vulnerabilities = {};
for (const a of advisories[rel] || []) {
    const pkg = vulnerabilities[a.package] || (vulnerabilities[a.package] = { name: a.package, severity: a.severity, isDirect: false, via: [], effects: [], range: a.range, nodes: [], fixAvailable: true });
    pkg.via.push({ source: 1, name: a.package, dependency: a.package, title: a.title || a.id, url: 'https://github.com/advisories/' + a.id, severity: a.severity, range: a.range });
}
process.stdout.write(JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...c, moderate: 0, low: 0, info: 0 } } }));
process.exit(${npmExit});
`);
    fs.chmodSync(path.join(bin, 'npm'), 0o755);
    return { dir, bin };
}

function run({ dir, bin }, args = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/audit-ratchet.mjs'), ...args], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

function writtenBaseline({ dir }) {
    return JSON.parse(fs.readFileSync(path.join(dir, '.github/security/audit-baseline.json'), 'utf8'));
}

const CLEAN = { server: { critical: 0, high: 2 }, 'agent-hub': { critical: 0, high: 1 }, 'nextcloud-connector': { critical: 0, high: 0 }, desktop: { critical: 0, high: 0 }, '.': { critical: 0, high: 0 } };
const baselineOf = (counts) => ({
    counts: Object.fromEntries(Object.entries(counts).map(([d, c]) => [d, { critical: c.critical, high: c.high }])),
});

test('npm audit exiting non-zero is the normal case, not an error', () => {
    // The real npm audit exits 1 whenever it finds anything, which here is
    // always. An implementation that treats that as a failure reports nothing
    // and passes — a gate that is silently blind.
    const box = sandbox({ counts: CLEAN, baseline: baselineOf(CLEAN), npmExit: 1 });
    const r = run(box);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /server .*: unchanged — 0 critical, 2 high/);
});

test('one more high advisory fails the gate, naming the package directory', () => {
    const worse = { ...CLEAN, server: { critical: 0, high: 3 } };
    const box = sandbox({ counts: worse, baseline: baselineOf(CLEAN) });
    const r = run(box);
    assert.strictEqual(r.code, 1, 'the ratchet let a regression through');
    assert.match(r.stdout, /❌ server/);
    assert.match(r.stdout, /high 2 → 3/);
});

test('a new critical fails even when the high count drops', () => {
    // The trap: netting the two together lets a critical in behind a tidy-up.
    const mixed = { ...CLEAN, 'agent-hub': { critical: 1, high: 0 } };
    const box = sandbox({ counts: mixed, baseline: baselineOf(CLEAN) });
    const r = run(box);
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /❌ agent-hub.*critical 0 → 1/);
});

test('fixing something passes, and says the baseline can come down', () => {
    const better = { ...CLEAN, server: { critical: 0, high: 0 } };
    const box = sandbox({ counts: better, baseline: baselineOf(CLEAN) });
    const r = run(box);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /✅ server/);
    assert.match(r.stdout, /--update/);
});

test('--update lowers the baseline and never raises it', () => {
    // Otherwise running the updater after a regression quietly blesses it, and
    // the gate has been disarmed by the tool that was supposed to maintain it.
    const worse = { ...CLEAN, server: { critical: 0, high: 9 } };
    const box = sandbox({ counts: worse, baseline: baselineOf(CLEAN) });
    const r = run(box, ['--update']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(writtenBaseline(box).counts.server.high, 2, 'the updater raised the baseline over a regression');

    // And with the regression still present, the gate still refuses.
    assert.strictEqual(run(box).code, 1);
});

test('a missing baseline entry fails rather than passing by default', () => {
    // A directory added to TARGETS without a baseline must not be waved
    // through: "no record" is not "no vulnerabilities".
    const partial = { counts: { server: { critical: 0, high: 2 } } };
    const box = sandbox({ counts: CLEAN, baseline: partial });
    const r = run(box);
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /❓ agent-hub: no baseline entry/);
});

// ── Which advisories, not just how many ──────────────────────────────────────

const OLD = { id: 'GHSA-aaaa-aaaa-aaaa', package: 'left-pad', range: '<1.3.0', severity: 'high', title: 'left-pad: ReDoS' };
const NEW = { id: 'GHSA-bbbb-bbbb-bbbb', package: 'lodash', range: '<4.17.21', severity: 'high', title: 'lodash: prototype pollution' };
const recorded = (counts, ids, accepted) => ({ ...baselineOf(counts), advisories: { server: ids }, ...(accepted ? { accepted } : {}) });

test('the same count with a different advisory fails, naming the new id', () => {
    // The count says "2 high, unchanged"; only the ids show that one advisory
    // was traded for another. That swap is exactly what a count cannot see.
    const box = sandbox({ counts: CLEAN, baseline: recorded(CLEAN, [OLD.id]), advisories: { server: [NEW] } });
    const r = run(box);
    assert.strictEqual(r.code, 1, 'a swapped advisory passed the gate');
    assert.match(r.stdout, /server .*: unchanged — 0 critical, 2 high/);
    assert.match(r.stdout, /❌ server: new advisory GHSA-bbbb-bbbb-bbbb \(high\) in lodash <4\.17\.21: lodash: prototype pollution/);
});

test('an advisory the baseline records passes, and a recorded one that is gone is reported', () => {
    const box = sandbox({ counts: CLEAN, baseline: recorded(CLEAN, [OLD.id, NEW.id]), advisories: { server: [OLD] } });
    const r = run(box);
    assert.strictEqual(r.code, 0, r.stdout);
    assert.match(r.stdout, /✅ server: 1 recorded advisory is gone/);
});

test('an accepted id passes until it expires', () => {
    const live = recorded(CLEAN, [OLD.id], [{ id: NEW.id, reason: 'template() is never called with user input', expires: '2999-12-31' }]);
    const ok = run(sandbox({ counts: CLEAN, baseline: live, advisories: { server: [NEW] } }));
    assert.strictEqual(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /GHSA-bbbb-bbbb-bbbb accepted until 2999-12-31 — template\(\) is never called/);

    const stale = recorded(CLEAN, [OLD.id], [{ id: NEW.id, reason: 'template() is never called with user input', expires: '2000-01-01' }]);
    const r = run(sandbox({ counts: CLEAN, baseline: stale, advisories: { server: [NEW] } }));
    assert.strictEqual(r.code, 1, 'an expired allowlist entry still accepted the advisory');
    assert.match(r.stdout, /❌ server: allowlist entry for GHSA-bbbb-bbbb-bbbb expired on 2000-01-01/);
});

test('package plus range accepts an advisory too, and a different range does not', () => {
    const byRange = (range) => recorded(CLEAN, [OLD.id], [{ package: 'lodash', range, reason: 'not reachable', expires: '2999-12-31' }]);
    assert.strictEqual(run(sandbox({ counts: CLEAN, baseline: byRange('<4.17.21'), advisories: { server: [NEW] } })).code, 0);
    const r = run(sandbox({ counts: CLEAN, baseline: byRange('<4.0.0'), advisories: { server: [NEW] } }));
    assert.strictEqual(r.code, 1, 'an entry for another range accepted the advisory');
    assert.match(r.stdout, /new advisory GHSA-bbbb-bbbb-bbbb/);
});

test('a malformed allowlist entry fails the gate instead of accepting anything', () => {
    // No reason and no expiry is not "accepted forever"; it is a broken record.
    const bad = recorded(CLEAN, [OLD.id], [{ id: NEW.id }]);
    const r = run(sandbox({ counts: CLEAN, baseline: bad, advisories: { server: [NEW] } }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /accepted\[0\]: needs a `reason`/);
    assert.match(r.stdout, /accepted\[0\]: needs an `expires` date/);
    assert.match(r.stdout, /new advisory GHSA-bbbb-bbbb-bbbb/, 'the entry it could not read must not accept the advisory either');
});

test('--update records the ids on first run and only ever drops one after', () => {
    // First record: a baseline written before ids existed takes the whole set,
    // otherwise every install would be red until somebody hand-typed them.
    const first = sandbox({ counts: CLEAN, baseline: baselineOf(CLEAN), advisories: { server: [OLD] } });
    assert.strictEqual(run(first, ['--update']).code, 0);
    assert.deepStrictEqual(writtenBaseline(first).advisories.server, [OLD.id]);
    assert.strictEqual(run(first).code, 0, 'the freshly recorded set must pass');

    // After that, an id that appeared is NOT recorded by the updater: it is
    // either fixed or accepted by hand, with the reason written down.
    const later = sandbox({ counts: CLEAN, baseline: recorded(CLEAN, [OLD.id]), advisories: { server: [OLD, NEW] } });
    assert.strictEqual(run(later, ['--update']).code, 0);
    assert.deepStrictEqual(writtenBaseline(later).advisories.server, [OLD.id], 'the updater blessed a new advisory');
    assert.strictEqual(run(later).code, 1, 'the gate must still refuse the new id after --update');

    // And a fixed one leaves the record.
    const fixed = sandbox({ counts: CLEAN, baseline: recorded(CLEAN, [OLD.id, NEW.id]), advisories: { server: [OLD] } });
    assert.strictEqual(run(fixed, ['--update']).code, 0);
    assert.deepStrictEqual(writtenBaseline(fixed).advisories.server, [OLD.id]);
});

test('--update keeps the hand-written allowlist', () => {
    const accepted = [{ id: NEW.id, reason: 'not reachable', expires: '2999-12-31' }];
    const box = sandbox({ counts: CLEAN, baseline: recorded(CLEAN, [OLD.id], accepted), advisories: { server: [OLD, NEW] } });
    assert.strictEqual(run(box, ['--update']).code, 0);
    assert.deepStrictEqual(writtenBaseline(box).accepted, accepted);
});

test('the committed baseline matches the shape the script reads', () => {
    // The real file, not a fixture: a baseline the script cannot parse would
    // make every run fall into the "write a new baseline" branch and pass.
    const real = JSON.parse(fs.readFileSync(path.join(REPO, '.github/security/audit-baseline.json'), 'utf8'));
    assert.ok(real.counts, 'the committed baseline has no counts');
    assert.ok(real.advisories, 'the committed baseline records no advisory ids');
    for (const dir of ['server', 'agent-hub', 'nextcloud-connector', '.']) {
        assert.ok(real.counts[dir], `no baseline entry for ${dir}`);
        assert.strictEqual(typeof real.counts[dir].critical, 'number');
        assert.strictEqual(typeof real.counts[dir].high, 'number');
        assert.ok(Array.isArray(real.advisories[dir]), `no advisory record for ${dir}`);
        for (const id of real.advisories[dir]) assert.match(id, /^GHSA-[0-9a-z-]+$|^\d+$/, `${dir}: odd advisory id ${id}`);
    }
    assert.ok(Array.isArray(real.accepted), 'the committed baseline has no `accepted` list');
    for (const a of real.accepted) {
        assert.ok(typeof a.id === 'string' || typeof a.package === 'string', 'accepted entry without id or package');
        assert.ok(typeof a.reason === 'string' && a.reason.trim(), 'accepted entry without a reason');
        assert.match(a.expires, /^\d{4}-\d{2}-\d{2}$/, 'accepted entry without an expiry');
    }
});

test('the counts come from the lockfile, not from node_modules', () => {
    // dependency-audit.yml no longer runs `npm ci`, so --package-lock-only is
    // load-bearing, not cosmetic: without it the result depends on whatever is
    // installed — identical in CI today, silently different on a developer
    // machine with a stale tree, and the workflow comment's claim that the
    // audit sees the shipping tree would stop being true.
    const box = sandbox({ counts: CLEAN, baseline: baselineOf(CLEAN) });
    assert.strictEqual(run(box).code, 0);
    const calls = fs.readFileSync(path.join(box.dir, 'npm-calls.log'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(calls.length, 5, 'expected one npm audit per target');
    for (const c of calls) {
        assert.ok(c.argv.includes('--package-lock-only'), `npm ${c.argv.join(' ')} in ${c.dir} — missing --package-lock-only`);
    }
});

test('shipping packages are still audited without their dev dependencies', () => {
    // Guards the pairing: --package-lock-only must not have displaced
    // --omit=dev, which is what keeps a vulnerable test runner out of a
    // shipping package's count (see WHAT IT COUNTS in the script).
    const box = sandbox({ counts: CLEAN, baseline: baselineOf(CLEAN) });
    run(box);
    const byDir = Object.fromEntries(fs.readFileSync(path.join(box.dir, 'npm-calls.log'), 'utf8')
        .trim().split('\n').map((l) => JSON.parse(l)).map((c) => [c.dir, c.argv]));
    for (const d of ['server', 'agent-hub', 'nextcloud-connector', 'desktop']) {
        assert.ok(byDir[d].includes('--omit=dev'), `${d} is a shipping package and must be audited --omit=dev`);
    }
    assert.ok(!byDir['.'].includes('--omit=dev'), 'the root is tooling: its whole tree counts');
});

test('the audit workflow checks every target lockfile and installs none', () => {
    // Two regressions this locks down, both of which look like tidying:
    //  1. re-adding `npm ci` "so the audit sees the real tree" — it already
    //     does; that install was ~66 s of a ~92 s job on one of the only two
    //     contexts that gate a merge.
    //  2. deleting the --dry-run loop as a no-op — it is the only
    //     pull-request check that package.json and package-lock.json agree
    //     for the repository root.
    const raw = fs.readFileSync(path.join(REPO, '.github/workflows/dependency-audit.yml'), 'utf8');
    // Comments in that file discuss `npm ci` at length, and a log label could
    // quote it too; match on runnable, non-echo lines only.
    const wf = raw.split('\n').filter((l) => !/^\s*#/.test(l) && !/^\s*echo /.test(l)).join('\n');

    const dryRun = wf.match(/npm ci --dry-run[^\n]*/g) || [];
    assert.strictEqual(dryRun.length, 1, 'the lockfile sync check is gone from dependency-audit.yml');
    assert.match(dryRun[0], /--ignore-scripts/);
    assert.deepStrictEqual(wf.match(/npm ci(?! --dry-run)/g) || [], [],
        'dependency-audit.yml installs dependency trees again — see the comment above that step');

    const loop = wf.match(/for d in ([^;]+); do/);
    assert.ok(loop, 'no manifest loop in dependency-audit.yml');
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const targets = [...src.matchAll(/\{\s*dir:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.strictEqual(targets.length, 5, 'TARGETS changed — update this test and the workflow loop together');
    assert.deepStrictEqual(new Set(loop[1].trim().split(/\s+/)), new Set(targets),
        'the workflow loop and TARGETS in scripts/audit-ratchet.mjs have drifted apart');
});

/**
 * The `Ratchet` step of dependency-audit.yml as GitHub runs it: its `run:`
 * body, and the command GitHub wraps it in for the step's `shell:`. A narrow
 * reader for one step — scripts/ carries no YAML package — that refuses a
 * shape it does not know rather than guessing.
 */
function ratchetStep() {
    const lines = fs.readFileSync(path.join(REPO, '.github/workflows/dependency-audit.yml'), 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*- name: Ratchet\s*$/.test(l));
    assert.notStrictEqual(start, -1, 'no `- name: Ratchet` step in dependency-audit.yml');
    const keyIndent = lines[start].indexOf('-') + 2;
    let shell = null;
    let run = null;
    for (let i = start + 1; i < lines.length; i += 1) {
        const l = lines[i];
        if (l.trim() === '' || /^\s*#/.test(l)) continue;
        const indent = l.search(/\S/);
        if (indent < keyIndent) break; // the next step, or the end of `steps:`
        if (indent > keyIndent) continue; // inside a block this reader skips
        const m = /^\s*([A-Za-z-]+):\s*(.*)$/.exec(l);
        assert.ok(m, `cannot read line ${i + 1} of the Ratchet step: ${l}`);
        if (m[1] === 'shell') shell = m[2].trim();
        if (m[1] !== 'run') continue;
        const value = m[2].trim();
        assert.ok(!value.startsWith('>'), 'the Ratchet step uses a folded run: — teach this reader, do not guess');
        if (!value.startsWith('|')) {
            run = value;
            continue;
        }
        const body = [];
        for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > keyIndent); j += 1) {
            body.push(lines[j]);
        }
        const strip = Math.min(...body.filter((b) => b.trim() !== '').map((b) => b.search(/\S/)));
        run = body.map((b) => b.slice(strip)).join('\n');
    }
    assert.ok(run, 'the Ratchet step has no run:');
    // https://docs.github.com/actions/reference/workflow-syntax-for-github-actions#jobsjob_idstepsshell
    const SHELLS = {
        null: ['bash', '-e'],
        bash: ['bash', '--noprofile', '--norc', '-eo', 'pipefail'],
        sh: ['sh', '-e'],
    };
    assert.ok(String(shell) in SHELLS, `the Ratchet step's shell: ${shell} is one this test cannot reproduce`);
    return { argv: SHELLS[String(shell)], run };
}

/** Runs a step body in a sandbox whose scripts/audit-ratchet.mjs exits `exit`. */
function runStep({ argv, run }, exit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-step-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'runner-temp'));
    fs.writeFileSync(path.join(dir, 'scripts/audit-ratchet.mjs'), `console.log('fake ratchet, exiting ${exit}'); process.exit(${exit});\n`);
    fs.writeFileSync(path.join(dir, 'step.sh'), `${run}\n`);
    const r = spawnSync(argv[0], [...argv.slice(1), path.join(dir, 'step.sh')], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: path.join(dir, 'runner-temp') },
    });
    if (r.error) throw r.error;
    const summary = fs.existsSync(path.join(dir, 'runner-temp/audit.txt'))
        ? fs.readFileSync(path.join(dir, 'runner-temp/audit.txt'), 'utf8')
        : '';
    return { code: r.status, summary };
}

const HAS_BASH = !spawnSync('bash', ['-c', 'true']).error;

test('a failing ratchet fails the Ratchet step, and the summary still gets its output', { skip: !HAS_BASH && 'no bash on PATH' }, () => {
    // The harness must be able to see the bug it guards, or a green here
    // proves nothing: the line this step carried until 2026-09-23, under
    // GitHub's default shell, really does pass when the ratchet fails.
    const before = runStep({ argv: ['bash', '-e'], run: 'node scripts/audit-ratchet.mjs | tee "$RUNNER_TEMP/audit.txt"' }, 1);
    assert.strictEqual(before.code, 0, 'the harness no longer reproduces the masked exit code, so it cannot vouch for the fix');

    const step = ratchetStep();
    const failing = runStep(step, 1);
    assert.notStrictEqual(failing.code, 0,
        'the Ratchet step passes while scripts/audit-ratchet.mjs exits 1: the pipe into tee hides its exit code (set -o pipefail, or shell: bash)');
    assert.match(failing.summary, /fake ratchet, exiting 1/, 'the ratchet output no longer reaches $RUNNER_TEMP/audit.txt for the Summary step');

    const passing = runStep(step, 0);
    assert.strictEqual(passing.code, 0, 'the Ratchet step fails while the ratchet passes');
    assert.match(passing.summary, /fake ratchet, exiting 0/);
});
