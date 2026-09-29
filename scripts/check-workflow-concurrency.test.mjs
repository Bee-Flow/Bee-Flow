/**
 * A gate that only ever passes is indistinguishable from no gate.
 *
 * check-workflow-concurrency.mjs exists to stop two opposite mistakes: leaving
 * a 35-minute check suite running for a commit that no longer exists, and
 * cancelling a release halfway through a publish. Both are invisible in the
 * YAML, so every case below drives the REAL script over a synthetic tree and
 * asserts it REFUSES — plus one case that runs it over the real repository and
 * asserts it accepts.
 *
 * Sandbox style is copied from scripts/audit-ratchet.test.mjs: a throwaway dir
 * under os.tmpdir(), the real script copied in, driven through execFileSync.
 * No network, no YAML dependency.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'check-workflow-concurrency.mjs');
const REAL_WORKFLOWS = path.join(REPO, '.github/workflows');

/** A copy of the real workflow tree, with `edits` applied on top. */
function sandbox(edits = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfconc-'));
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/check-workflow-concurrency.mjs'));
    for (const name of fs.readdirSync(REAL_WORKFLOWS)) {
        if (!/\.ya?ml$/.test(name)) continue;
        fs.copyFileSync(path.join(REAL_WORKFLOWS, name), path.join(dir, '.github/workflows', name));
    }
    for (const [name, text] of Object.entries(edits)) {
        const target = path.join(dir, '.github/workflows', name);
        if (text === null) fs.rmSync(target);
        else fs.writeFileSync(target, text);
    }
    return dir;
}

const read = (name) => fs.readFileSync(path.join(REAL_WORKFLOWS, name), 'utf8');

/** Delete the top-level concurrency block from a workflow's text. */
function stripConcurrency(text) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^concurrency:/.test(l));
    assert.notStrictEqual(start, -1, 'fixture has no concurrency block to strip');
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (/^[A-Za-z0-9_'"-]+:/.test(lines[i])) {
            end = i;
            break;
        }
    }
    // Take the comment lines immediately above it too.
    let top = start;
    while (top > 0 && /^\s*#/.test(lines[top - 1])) top -= 1;
    return [...lines.slice(0, top), ...lines.slice(end)].join('\n');
}

function run(dir) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/check-workflow-concurrency.mjs')], {
            cwd: dir,
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

// 1
test('the real repository tree passes', () => {
    const r = run(REPO);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /each in exactly one bucket/);
});

// 2
test('flipping connector-release to cancel-in-progress: true is refused', () => {
    const broken = read('connector-release.yml').replace('cancel-in-progress: false', 'cancel-in-progress: true');
    assert.match(broken, /cancel-in-progress: true/, 'fixture did not apply');
    const r = run(sandbox({ 'connector-release.yml': broken }));
    assert.strictEqual(r.code, 1, 'a cancellable release was allowed');
    assert.match(r.stderr, /connector-release\.yml/);
    assert.match(r.stderr, /the Nextcloud App Store submission disagreeing/);
});

// 3 — the revert this patch exists to catch.
test('deleting ci.yml’s concurrency block is refused', () => {
    const r = run(sandbox({ 'ci.yml': stripConcurrency(read('ci.yml')) }));
    assert.strictEqual(r.code, 1, 'the supersede-cancelling was silently reverted');
    assert.match(r.stderr, /ci\.yml \[CONDITIONAL_CANCEL\]: no concurrency: block/);
});

// 4 — the main-verdict regression.
test('a bare `true` on ci.yml is refused, not just a missing block', () => {
    // This is the one that would silently destroy a push-to-main verdict.
    const broken = read('ci.yml').replace(
        /cancel-in-progress: \$\{\{[^\n]*\}\}/,
        'cancel-in-progress: true',
    );
    assert.match(broken, /cancel-in-progress: true/, 'fixture did not apply');
    const r = run(sandbox({ 'ci.yml': broken }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /must be a \$\{\{ … \}\} expression and never the bare literal `true`/);
});

// 5
test('dropping ‘prod’ from android-release’s cancel expression is refused', () => {
    const broken = read('android-release.yml').replace(
        /cancel-in-progress: \$\{\{[^\n]*\}\}/,
        'cancel-in-progress: ${{ github.event_name != \'workflow_dispatch\' }}',
    );
    const r = run(sandbox({ 'android-release.yml': broken }));
    assert.strictEqual(r.code, 1, 'a signed prod build became cancellable');
    assert.match(r.stderr, /no longer excludes 'prod'/);
});

// 6
test('adding concurrency to a reusable workflow is refused', () => {
    const broken = read('e2e-smoke.yml').replace(
        /^jobs:/m,
        'concurrency:\n  group: e2e-smoke\n  cancel-in-progress: true\n\njobs:',
    );
    const r = run(sandbox({ 'e2e-smoke.yml': broken }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /e2e-smoke\.yml \[NO_CONCURRENCY\]/);
    assert.match(r.stderr, /workflow_call reusable workflow/);
});

// 7
test('two workflows claiming the same group literal are refused', () => {
    // A group named after a required context is the sharp end of this: a
    // scheduled image-scan sharing `scan-` with secret-scan on main would
    // cancel a REQUIRED check.
    const a = read('release-dockerhub.yml').replace('group: dockerhub-release', "group: ${{ format('scan-{0}', github.ref) }}");
    const b = read('connector-release.yml').replace(
        'group: connector-release',
        "group: ${{ format('scan-{0}', github.ref) }}",
    );
    assert.notStrictEqual(a, read('release-dockerhub.yml'), 'fixture did not apply');
    const r = run(sandbox({ 'release-dockerhub.yml': a, 'connector-release.yml': b }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /both claim the concurrency group literal 'scan-'/);
});

// 8
test('a brand-new workflow in no bucket is refused', () => {
    const fresh = `name: Whatever

on:
  pull_request:

jobs:
  whatever:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const r = run(sandbox({ 'whatever.yml': fresh }));
    assert.strictEqual(r.code, 1, 'a new workflow slipped in without anyone deciding its cancel policy');
    assert.match(r.stderr, /whatever\.yml: in no bucket/);
});

// 9
test('a job-level concurrency key trips the parser assumption, it does not pass silently', () => {
    const broken = read('secret-scan.yml').replace(
        /^ {2}scan:$/m,
        '  scan:\n    concurrency:\n      group: scan\n      cancel-in-progress: true',
    );
    assert.match(broken, /^ {4}concurrency:$/m, 'fixture did not apply');
    const r = run(sandbox({ 'secret-scan.yml': broken }));
    assert.strictEqual(r.code, 1, 'a job-level concurrency block was read as "no concurrency"');
    assert.match(r.stderr, /column-0 scanning and that assumption no longer holds for secret-scan\.yml/);
});
