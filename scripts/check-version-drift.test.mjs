/**
 * The ratchet is a gate, so it has to REFUSE: a count over the budget, an
 * --update that would raise it, a lockstep group that disagrees. And the count
 * has to DISCRIMINATE: specs that name no version and a same-major pair must
 * not count, a drifting name counts once however many majors it has.
 *
 * Sandbox style is the one scripts/count-ratchet.test.mjs uses: a throwaway
 * repo under os.tmpdir() with the real script copied in.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { declared, drifting, lockstepViolations, majorOf } from './check-version-drift.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const registryOf = (pkgs) => ({ packages: Object.keys(pkgs).map((dir) => ({ dir, ecosystem: 'npm' })).concat([{ dir: 'svc', ecosystem: 'pip' }]) });

function sandbox({ pkgs, budget = null }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-drift-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['check-version-drift.mjs', 'entry-point.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(dir, 'scripts', f));
    fs.writeFileSync(path.join(dir, 'scripts/packages.json'), JSON.stringify(registryOf(pkgs)));
    for (const [d, json] of Object.entries(pkgs)) {
        fs.mkdirSync(path.join(dir, d), { recursive: true });
        fs.writeFileSync(path.join(dir, d, 'package.json'), JSON.stringify(json));
    }
    if (budget !== null) fs.writeFileSync(path.join(dir, '.version-drift-ratchet.json'), JSON.stringify({ count: budget }));
    return dir;
}

function run(dir, extra = []) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/check-version-drift.mjs'), ...extra], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.version-drift-ratchet.json'), 'utf8')).count;

const YJS = { yjs: '13.6.33', 'y-protocols': '1.0.7', lib0: '0.2.119' };
const TWO_DRIFTS = {
    server: { dependencies: { ...YJS, x: '^1.2.0', y: '~1.0.0', same: '^3.0.0' } },
    'agent-hub': { devDependencies: { x: '^2.0.0', y: '2.9.1', same: '^3.4.0' }, dependencies: YJS },
};

test('majorOf reads the major of a range and nothing else', () => {
    for (const [range, major] of [['^13.6.3', 13], ['~5.9.2', 5], ['4.0.12', 4], ['v2.1.0', 2], ['>=2 <4', 2], ['1.x', 1], ['^1.2.3-beta.1', 1], ['^6 || ^7', 7], ['0.562.0', 0]]) {
        assert.strictEqual(majorOf(range), major, range);
    }
    for (const spec of ['*', 'latest', 'npm:other@^2', 'file:../x', 'workspace:*', 'github:a/b', 'git+https://x/y.git', '', '<3', undefined]) {
        assert.strictEqual(majorOf(spec), null, String(spec));
    }
});

test('a name on two majors counts once, however many packages or majors, and a same-major pair not at all', () => {
    const decl = declared([
        { dir: 'a', json: { dependencies: { x: '^1.0.0', same: '^3.0.0' } } },
        { dir: 'b', json: { devDependencies: { x: '^2.0.0', same: '^3.9.0' } } },
        { dir: 'c', json: { optionalDependencies: { x: '^3.0.0' } } },
        { dir: 'd', json: { dependencies: { lonely: '^1.0.0', odd: 'npm:x@^1', odd2: 'file:../x' } } },
    ]);
    const rows = drifting(decl);
    assert.deepStrictEqual(rows.map((r) => r.name), ['x']);
    assert.deepStrictEqual([...rows[0].majors.keys()].sort(), [1, 2, 3]);
});

test('a spec that names no version does not make a drift', () => {
    const rows = drifting(declared([{ dir: 'a', json: { dependencies: { x: '^1.0.0' } } }, { dir: 'b', json: { dependencies: { x: 'workspace:*' } } }]));
    assert.deepStrictEqual(rows, []);
});

test('lockstep: equal passes, a difference or a missing one is named', () => {
    const group = [{ names: ['yjs', 'lib0'], dirs: ['server', 'agent-hub'], why: 'bundled' }];
    const ok = declared([{ dir: 'server', json: { dependencies: { yjs: '13.6.33', lib0: '0.2.119' } } }, { dir: 'agent-hub', json: { dependencies: { yjs: '13.6.33', lib0: '0.2.119' } } }]);
    assert.deepStrictEqual(lockstepViolations(ok, group), []);
    const differ = declared([{ dir: 'server', json: { dependencies: { yjs: '13.6.33', lib0: '0.2.119' } } }, { dir: 'agent-hub', json: { dependencies: { yjs: '^13.6.33', lib0: '0.2.119' } } }]);
    const v = lockstepViolations(differ, group);
    assert.strictEqual(v.length, 1);
    assert.match(v[0], /yjs differs: server 13\.6\.33 vs agent-hub \^13\.6\.33/);
    const missing = declared([{ dir: 'server', json: { dependencies: { yjs: '13.6.33', lib0: '0.2.119' } } }, { dir: 'agent-hub', json: { dependencies: { yjs: '13.6.33' } } }]);
    assert.match(lockstepViolations(missing, group)[0], /lib0 is not declared in agent-hub/);
});

test('more drift than the budget fails, at or under passes', () => {
    const over = run(sandbox({ pkgs: TWO_DRIFTS, budget: 1 }));
    assert.strictEqual(over.code, 1);
    assert.match(over.stderr, /2 dependencies on different majors in 2\+ npm packages, budget is 1/);
    const at = run(sandbox({ pkgs: TWO_DRIFTS, budget: 2 }));
    assert.strictEqual(at.code, 0, at.stderr);
    assert.match(at.stdout, /at budget/);
    const under = run(sandbox({ pkgs: TWO_DRIFTS, budget: 5 }));
    assert.strictEqual(under.code, 0);
    assert.match(under.stdout, /under the budget of 5/);
});

test('only npm packages of the registry are read', () => {
    const dir = sandbox({ pkgs: TWO_DRIFTS, budget: 2 });
    // the registry also lists a pip package "svc" with no package.json: it must not be opened
    assert.strictEqual(run(dir).code, 0);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox({ pkgs: TWO_DRIFTS, budget: 9 });
    assert.strictEqual(run(lower, ['--update']).code, 0);
    assert.strictEqual(budgetOf(lower), 2);
    const higher = sandbox({ pkgs: TWO_DRIFTS, budget: 1 });
    assert.strictEqual(run(higher, ['--update']).code, 0);
    assert.strictEqual(budgetOf(higher), 1, 'an --update must not become a quiet way to raise the budget');
});

test('a missing budget file is written from the first measurement', () => {
    const dir = sandbox({ pkgs: TWO_DRIFTS });
    assert.strictEqual(run(dir).code, 0);
    assert.strictEqual(budgetOf(dir), 2);
});

test('a lockstep difference fails even when the count is under budget', () => {
    const dir = sandbox({
        pkgs: {
            server: { dependencies: { yjs: '13.6.33', 'y-protocols': '1.0.7', lib0: '0.2.119' } },
            'agent-hub': { dependencies: { yjs: '13.7.0', 'y-protocols': '1.0.7', lib0: '0.2.119' } },
        },
        budget: 5,
    });
    const r = run(dir);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /lockstep: yjs differs: server 13\.6\.33 vs agent-hub 13\.7\.0/);
});

test('--list names who is on which major', () => {
    const r = run(sandbox({ pkgs: TWO_DRIFTS, budget: 2 }), ['--list']);
    assert.match(r.stdout, /x: 1 in server; 2 in agent-hub/);
});

test('a package listed in the registry without a package.json is a usage error, not a pass', () => {
    const dir = sandbox({ pkgs: TWO_DRIFTS, budget: 2 });
    fs.rmSync(path.join(dir, 'agent-hub'), { recursive: true });
    const r = run(dir);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /version-drift:/);
});
