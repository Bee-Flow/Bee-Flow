/**
 * check-required-checks.mjs is a gate, so the thing worth testing is that it
 * REFUSES. A checker that only ever passes is indistinguishable from no
 * checker — the same argument scripts/audit-ratchet.test.mjs makes in its own
 * header, and the reason every case below asserts a NON-ZERO exit except the
 * happy path.
 *
 * Each case builds a throwaway repo under os.tmpdir() with a .github/workflows/
 * and a .github/required-checks.json, copies the real checker in, and drives it
 * through execFileSync. No network, no git, no YAML dependency.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'check-required-checks.mjs');

/** A workflow with one plain job, PR-triggered, no paths filter. */
const plain = (jobId, extra = '') => `name: ${jobId}

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  ${jobId}:
    runs-on: ubuntu-latest
${extra}    steps:
      - uses: actions/checkout@v4
`;

const HAPPY = { 'secret-scan.yml': plain('scan'), 'dependency-audit.yml': plain('audit') };

function sandbox(workflows, contexts = ['scan', 'audit']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqchecks-'));
    fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/check-required-checks.mjs'));
    fs.writeFileSync(
        path.join(dir, '.github/required-checks.json'),
        JSON.stringify({ required_contexts: contexts }, null, 2),
    );
    for (const [name, text] of Object.entries(workflows)) {
        fs.writeFileSync(path.join(dir, '.github/workflows', name), text);
    }
    return dir;
}

function run(dir) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/check-required-checks.mjs')], {
            cwd: dir,
            encoding: 'utf8',
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

// 1
test('a clean tree passes', () => {
    const r = run(sandbox(HAPPY));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /2 contexts \(scan, audit\)/);
});

// 2 — the regression this whole change exists for.
test('a second job whose ID is a required context fails, even behind a matrix', () => {
    // This is image-scan.yml's exact shape before the rename: a matrix job
    // called `scan`, which emits `scan (server)` today and a bare `scan` the
    // moment someone collapses the matrix to one image. Pinning it here is
    // what stops the rename being silently reverted.
    const matrixScan = `name: Image scan

on:
  schedule:
    - cron: '0 4 * * 2'
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        image: [server, guard]
    steps:
      - uses: actions/checkout@v4
`;
    const r = run(sandbox({ ...HAPPY, 'image-scan.yml': matrixScan }));
    assert.strictEqual(r.code, 1, 'the checker let the collision through');
    assert.match(r.stderr, /image-scan\.yml: job id 'scan' collides with required context 'scan'/);
    assert.match(r.stderr, /secret-scan\.yml/, 'the message must name the real producer too');
});

// 3
test('two jobs emitting the same required context fail', () => {
    const r = run(sandbox({ ...HAPPY, 'other.yml': plain('scan') }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /required context 'scan' is emitted by 2 jobs/);
});

// 4
test('a required context nobody emits fails rather than passing by default', () => {
    const r = run(sandbox(HAPPY, ['scan', 'audit', 'typecheck']));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /no job emits required context 'typecheck' — the check will never report/);
});

// 5
test('a matrix producer fails: it emits the parenthesised form, never the bare name', () => {
    const matrixOnly = `name: Secret scan

on:
  pull_request:

jobs:
  scan:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        part: [a, b]
    steps:
      - uses: actions/checkout@v4
`;
    const r = run(sandbox({ 'secret-scan.yml': matrixOnly, 'dependency-audit.yml': plain('audit') }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /is a matrix; it emits 'scan \(…\)' and never a bare 'scan'/);
});

// 6 — the `checks` prerequisite, made mechanical.
test('promoting `checks` fails on BOTH the duplicate and the paths filter', () => {
    // This keeps "rename first, drop the paths filters second, require third"
    // alive after everyone who read the note has left. Both frontend-checks and
    // mobile-checks emit `checks`, and both are paths-filtered.
    const filtered = (app) => `name: ${app} checks

on:
  pull_request:
    paths:
      - '${app}/**'

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const r = run(
        sandbox(
            { ...HAPPY, 'frontend-checks.yml': filtered('agent-hub'), 'mobile-checks.yml': filtered('mobile') },
            ['scan', 'audit', 'checks'],
        ),
    );
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /required context 'checks' is emitted by 2 jobs/);
    assert.match(r.stderr, /frontend-checks\.yml filters it by paths:/);
    assert.match(r.stderr, /mobile-checks\.yml filters it by paths:/);
});

// 7
test('a producer with no pull_request trigger fails', () => {
    const scheduled = `name: Secret scan

on:
  schedule:
    - cron: '0 4 * * 2'
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const r = run(sandbox({ 'secret-scan.yml': scheduled, 'dependency-audit.yml': plain('audit') }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /'scan' is required but .*secret-scan\.yml has no pull_request trigger/);
});

// 8
test('a conditional producer fails', () => {
    const r = run(sandbox({ ...HAPPY, 'secret-scan.yml': plain('scan', "    if: github.actor != 'dependabot[bot]'\n") }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /the job producing required context 'scan' is conditional/);
});

// 8b — the one condition an aggregate job needs.
test('an `if: always()` producer passes; any other condition still fails', () => {
    for (const cond of ['always()', '${{ always() }}']) {
        const r = run(sandbox({ ...HAPPY, 'secret-scan.yml': plain('scan', `    if: ${cond}\n`) }));
        assert.strictEqual(r.code, 0, `${cond}: ${r.stderr}`);
    }
    // `always() && …` is not `always()`: a dependency failure could still skip it.
    const r = run(sandbox({ ...HAPPY, 'secret-scan.yml': plain('scan', "    if: always() && needs.build.result == 'success'\n") }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /carries a top-level if: other than always\(\)/);
});

// 9
test('a `name:` override is what GitHub reports, not the job id', () => {
    // Job id `audit`, display name something else: the context `audit` is then
    // unproduced. A checker that read ids would call this fine and every PR
    // would block on a check that never reports.
    const renamed = plain('audit', '    name: Dependency audit (A.8.8)\n');
    const r = run(sandbox({ ...HAPPY, 'dependency-audit.yml': renamed }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /no job emits required context 'audit'/);
});

// 10
test('an unparseable workflow fails closed, never a silent skip', () => {
    const tabbed = HAPPY['secret-scan.yml'].replace('    runs-on: ubuntu-latest', '\truns-on: ubuntu-latest');
    const tabRun = run(sandbox({ ...HAPPY, 'tabbed.yml': tabbed }));
    assert.strictEqual(tabRun.code, 1);
    assert.match(tabRun.stderr, /cannot parse .*tabbed\.yml: it contains a tab/);
    assert.match(tabRun.stderr, /widen it rather than loosening it/);

    const inline = `name: Inline

on: [pull_request]

jobs:
  something:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const inlineRun = run(sandbox({ ...HAPPY, 'inline.yml': inline }));
    assert.strictEqual(inlineRun.code, 1);
    assert.match(inlineRun.stderr, /cannot parse .*inline\.yml: .*inline flow form/);
});

// 11 — R8: the aggregate blocks only on what it needs.
test('an if: always() aggregate must need every other job in its workflow', () => {
    // ci.yml's shape: package jobs plus `checks-passed`, which is green when
    // every job it NEEDS passed or was skipped. A job added to the workflow
    // but not to that list runs, goes red, and blocks nothing.
    const ci = (needs) => `name: CI

on:
  pull_request:

jobs:
  changes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  server:
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  mobile:
    needs: changes
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  checks-passed:
${needs}    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: true
`;
    const contexts = ['scan', 'audit', 'checks-passed'];

    const missing = run(sandbox({ ...HAPPY, 'ci.yml': ci('    needs: [changes, server]\n') }, contexts));
    assert.strictEqual(missing.code, 1, 'an aggregate that does not need `mobile` let it through');
    assert.match(
        missing.stderr,
        /required context 'checks-passed' is an aggregate \(.*ci\.yml:checks-passed, if: always\(\)\) that does not need mobile;/,
    );

    const none = run(sandbox({ ...HAPPY, 'ci.yml': ci('') }, contexts));
    assert.strictEqual(none.code, 1);
    assert.match(none.stderr, /does not need changes, server, mobile;/);

    for (const needs of [
        '    needs: [changes, server, mobile]\n',
        "    needs: ['changes', \"server\", mobile]  # every job\n",
        '    needs:\n      - changes\n      - server\n      - mobile\n',
    ]) {
        const r = run(sandbox({ ...HAPPY, 'ci.yml': ci(needs) }, contexts));
        assert.strictEqual(r.code, 0, `${JSON.stringify(needs)}: ${r.stderr}`);
    }

    // A needs: list the scanner cannot read fails closed, never as "needs nothing".
    const odd = run(sandbox({ ...HAPPY, 'ci.yml': ci('    needs:\n      - ${{ matrix.x }}\n') }, contexts));
    assert.strictEqual(odd.code, 1);
    assert.match(odd.stderr, /cannot parse .*ci\.yml: .*`needs:` list is not a job id/);
    const spanning = run(sandbox({ ...HAPPY, 'ci.yml': ci('    needs: [changes,\n      server, mobile]\n') }, contexts));
    assert.strictEqual(spanning.code, 1);
    assert.match(spanning.stderr, /cannot parse .*ci\.yml: .*`needs:` list that spans lines/);
});

// 11b — a plain producer is not an aggregate; R8 leaves it alone.
test('R8 applies to the if: always() producer only', () => {
    const withSibling = `${HAPPY['secret-scan.yml']}  unrelated:
    runs-on: ubuntu-latest
    steps:
      - run: true
`;
    const r = run(sandbox({ ...HAPPY, 'secret-scan.yml': withSibling }));
    assert.strictEqual(r.code, 0, r.stderr);
});

// 12–17 — R9, the two-way name. ci.yml's aggregate on a draft PR calls itself
// 'checks-passed (draft)', so a draft run can never satisfy the required
// context on the head SHA a ready run is about to test.
const DRAFT = "${{ github.event.pull_request.draft == true && 'checks-passed (draft)' || 'checks-passed' }}";
const CI_CONTEXTS = ['scan', 'audit', 'checks-passed'];

/** ci.yml's shape, reduced: one package job and the aggregate, named by `name`. */
const draftCi = (name, { ifLine = '    if: always()\n', strategy = '' } = {}) => `name: CI

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  server:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  checks-passed:
    name: ${name}
    needs: [server]
${ifLine}${strategy}    runs-on: ubuntu-latest
    steps:
      - run: true
`;

// 12
test('a two-way name that keeps the required context off draft runs passes', () => {
    const r = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(DRAFT) }, CI_CONTEXTS));
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(
        r.stdout,
        /ci\.yml:checks-passed names itself 'checks-passed \(draft\)' when github\.event\.pull_request\.draft == true/,
        'the log must show the two-way form was read, not taken for a literal',
    );

    for (const name of [
        "${{github.event.pull_request.draft == true&&'checks-passed (draft)'||'checks-passed'}}",
        `"${DRAFT}"`,
        `${DRAFT}  # a draft run never emits the required name`,
        // || inside parentheses and a string literal in the condition are fine.
        "${{ (github.event.pull_request.draft || github.event_name == 'merge_group') && 'checks-passed (draft)' || 'checks-passed' }}",
    ]) {
        const v = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(name) }, CI_CONTEXTS));
        assert.strictEqual(v.code, 0, `${name}: ${v.stderr}`);
    }

    // The required name on the true branch reads the other way round.
    const inverted = "${{ github.event.pull_request.draft != true && 'checks-passed' || 'checks-passed (draft)' }}";
    const inv = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(inverted) }, CI_CONTEXTS));
    assert.strictEqual(inv.code, 0, inv.stderr);
    assert.match(inv.stdout, /names itself 'checks-passed \(draft\)' unless github\.event\.pull_request\.draft != true/);
});

// 13
test('a two-way name whose branches are both required contexts fails', () => {
    const r = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(DRAFT) }, [...CI_CONTEXTS, 'checks-passed (draft)']));
    assert.strictEqual(r.code, 1, 'a job that picks between two required contexts was let through');
    assert.match(
        r.stderr,
        /ci\.yml:checks-passed: its two-way name: switches between two required contexts, 'checks-passed \(draft\)' and 'checks-passed'/,
    );
});

// 14
test('a two-way name with the same name on both branches fails', () => {
    const same = "${{ github.event.pull_request.draft == true && 'checks-passed' || 'checks-passed' }}";
    const r = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(same) }, CI_CONTEXTS));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /ci\.yml:checks-passed: its two-way name: yields 'checks-passed' on both branches/);
});

// 15
test('a two-way producer and a plain job emitting the same context are an R1 duplicate', () => {
    const r = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(DRAFT), 'other.yml': plain('checks-passed') }, CI_CONTEXTS));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /required context 'checks-passed' is emitted by 2 jobs: .*ci\.yml:checks-passed, .*other\.yml:checks-passed/);
});

// 16
test('a whole-value name expression outside the two-way grammar fails closed', () => {
    for (const name of [
        // no || branch
        "${{ github.event.pull_request.draft == true && 'checks-passed (draft)' }}",
        // double-quoted literals are not GitHub expression strings
        '${{ github.event.pull_request.draft == true && "checks-passed (draft)" || "checks-passed" }}',
        // a top-level || in the condition: the name could be the value of `draft`
        "${{ github.event.pull_request.draft || github.event_name == 'push' && 'checks-passed (draft)' || 'checks-passed' }}",
        // an empty literal: `&& ''` is falsy and always falls through to B
        "${{ github.event.pull_request.draft == true && '' || 'checks-passed' }}",
        // unbalanced parenthesis
        "${{ (github.event.pull_request.draft == true && 'checks-passed (draft)' || 'checks-passed' }}",
        // any other whole-value expression: what it emits is unknowable here
        '${{ inputs.aggregate_name }}',
    ]) {
        const r = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(name) }, CI_CONTEXTS));
        assert.strictEqual(r.code, 1, `${name} was read as something`);
        assert.match(r.stderr, /cannot parse .*ci\.yml: job `checks-passed` has a `name:` expression the scanner cannot resolve/, name);
    }

    // A matrix job whose name uses a matrix value gets no ` (…)` suffix, so a
    // two-way name there could emit the bare context after all.
    const matrix = draftCi(DRAFT, { strategy: '    strategy:\n      matrix:\n        shard: [1, 2]\n' });
    const m = run(sandbox({ ...HAPPY, 'ci.yml': matrix }, CI_CONTEXTS));
    assert.strictEqual(m.code, 1);
    assert.match(m.stderr, /cannot parse .*ci\.yml: job `checks-passed` is a matrix with a two-way `name:` expression/);
});

// 17
test('R5 still rejects a two-way producer with a condition other than always()', () => {
    for (const ifLine of ["    if: github.actor != 'dependabot[bot]'\n", "    if: always() && needs.server.result == 'success'\n"]) {
        const r = run(sandbox({ ...HAPPY, 'ci.yml': draftCi(DRAFT, { ifLine }) }, CI_CONTEXTS));
        assert.strictEqual(r.code, 1, `${ifLine.trim()} was let through`);
        assert.match(r.stderr, /the job producing required context 'checks-passed' is conditional \(.*ci\.yml:checks-passed/);
    }
});

// 18 — a name that merely CONTAINS an expression is still read literally.
test('an expression inside a longer name is not a two-way name', () => {
    const shards = `name: Frontend

on:
  pull_request:

jobs:
  frontend-tests:
    name: Frontend tests (\${{ matrix.shard }}/3)
    strategy:
      matrix:
        shard: [1, 2, 3]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  build:
    name: Build \${{ inputs.channel }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const r = run(sandbox({ ...HAPPY, 'frontend.yml': shards }));
    assert.strictEqual(r.code, 0, r.stderr);
});

// 19 — a `name:` is read the way YAML reads it: the comment is not the name.
test('a trailing comment on a name does not hide a duplicate producer', () => {
    for (const nameLine of ['    name: scan  # the same context, by accident\n', '    name: "scan" # quoted\n', "    name: 'scan'\n"]) {
        const r = run(sandbox({ ...HAPPY, 'other.yml': plain('other', nameLine) }));
        assert.strictEqual(r.code, 1, `${nameLine.trim()} hid a second producer of 'scan'`);
        assert.match(r.stderr, /required context 'scan' is emitted by 2 jobs/);
    }
    const escaped = run(sandbox({ ...HAPPY, 'other.yml': plain('other', '    name: "sc\\u0061n"\n') }));
    assert.strictEqual(escaped.code, 1);
    assert.match(escaped.stderr, /cannot parse .*other\.yml: job `other` has a quoted `name:` the scanner cannot resolve/);
});
