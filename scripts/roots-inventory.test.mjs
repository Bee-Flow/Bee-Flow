/**
 * The gate on scripts/roots-inventory.json (the real repository), and roots-inventory.mjs
 * itself on fixture checkouts: what must be listed, stale entries, the shape rules and the
 * pending budget that only goes down.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, requiredFiles, readInventory, shapeErrors, lowerBudget, main, namesPackage, INVENTORY_REL } from './roots-inventory.mjs';

test('the repository: every file that names a package directory is listed, every entry exists, pending within budget', () => {
    const r = check();
    assert.deepStrictEqual(r.missing, [], `add to ${INVENTORY_REL}: ${r.missing.join(', ')}`);
    assert.deepStrictEqual(r.stale, [], `remove from ${INVENTORY_REL}: ${r.stale.join(', ')}`);
    assert.deepStrictEqual(r.shape, []);
    assert.ok(r.pending <= r.budget, `${r.pending} pending entries over the budget of ${r.budget}: convert a tool instead`);
});

test('the repository: the budget is tight (run --update after a conversion)', () => {
    const r = check();
    assert.strictEqual(r.budget, r.pending, `pendingBudget ${r.budget} is above the ${r.pending} pending entries: node scripts/roots-inventory.mjs --update`);
});

test('namesPackage: a package directory as a path, a package joined from argv, a hand-made path inside a server root', () => {
    assert.ok(namesPackage('scripts/a.mjs', "const f = 'server/routes/x.js';"));
    assert.ok(namesPackage('scripts/a.mjs', "path.join(ROOT, 'agent-hub', 'src')"));
    assert.ok(namesPackage('scripts/a.mjs', 'const dir = path.resolve(ROOT, pkg);'));
    assert.ok(!namesPackage('scripts/a.mjs', 'the agent-hub image and the mcp-server/ folder'));
    assert.ok(!namesPackage('scripts/a.mjs', "const HERE = path.dirname(fileURLToPath(import.meta.url));"));
    assert.ok(namesPackage('server/scripts/a.js', "require(path.join(__dirname, '..', 'db'))", true));
    assert.ok(!namesPackage('server/scripts/data.json', '{"__dirname": 1}', true));
});

const tempDirs = [];
test.after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A checkout with a few files; `entries` becomes its inventory. */
function fixture(files, inventory) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-inventory-'));
    tempDirs.push(dir);
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    fs.writeFileSync(path.join(dir, INVENTORY_REL), `${JSON.stringify(inventory, null, 2)}\n`);
    return dir;
}

const GROUPS = { ratchets: 'walk a package' };
const BASE_FILES = {
    'server/index.js': '',
    'server/layering.test.js': "const ROOT = __dirname;\n",
    'server/db.test.js': "require('./db');\n",
    'server/scripts/run.mjs': "const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');\n",
    'server/testUtils/plain.js': "module.exports = {};\n",
    'scripts/walker.mjs': "fs.readdirSync(path.join(ROOT, 'server'));\n",
    'scripts/plain.mjs': "console.log('hello');\n",
    'scripts/notes.md': 'server/ everywhere',
    '.jscpd.json': '{}',
    '.github/workflows/ci.yml': 'on: push\n',
};

/** Run fn without BEEFLOW_MODULE_ROOTS, so the fixture's own modules/ (if any) applies. */
function defaultParents(fn) {
    const saved = process.env.BEEFLOW_MODULE_ROOTS;
    delete process.env.BEEFLOW_MODULE_ROOTS;
    try {
        return fn();
    } finally {
        if (saved !== undefined) process.env.BEEFLOW_MODULE_ROOTS = saved;
    }
}

test('requiredFiles: configs always, scanned files only when they name a package directory', () => defaultParents(() => {
    const dir = fixture(BASE_FILES, { pendingBudget: 0, groups: GROUPS, entries: [] });
    assert.deepStrictEqual(requiredFiles(dir), [
        '.github/workflows/ci.yml', '.jscpd.json', 'scripts/walker.mjs', 'server/layering.test.js', 'server/scripts/run.mjs',
    ]);
}));

test('requiredFiles: the scripts/, testUtils/ and top-level tests of a module server root are scanned too', () => defaultParents(() => {
    const dir = fixture({
        ...BASE_FILES,
        'modules/alpha/server/scripts/seed.js': "require(path.join(__dirname, '..', 'alpha', 'store'));\n",
        'modules/alpha/server/alpha.walk.test.js': "fs.readdirSync(__dirname);\n",
        'modules/alpha/server/alpha/store.js': "path.join(__dirname, 'x');\n",
    }, { pendingBudget: 0, groups: GROUPS, entries: [] });
    const required = requiredFiles(dir);
    assert.ok(required.includes('modules/alpha/server/scripts/seed.js'));
    assert.ok(required.includes('modules/alpha/server/alpha.walk.test.js'));
    assert.ok(!required.includes('modules/alpha/server/alpha/store.js'), 'production code is not scanned');
}));

test('check: a missing file, a stale entry and an over-budget count are each reported', () => defaultParents(() => {
    const entries = [
        { file: '.github/workflows/ci.yml', status: 'pending', group: 'ratchets', what: 'filters' },
        { file: '.jscpd.json', status: 'root-aware', what: 'whole repo' },
        { file: 'scripts/gone.mjs', status: 'pending', group: 'ratchets', what: 'was here' },
        { file: 'scripts/walker.mjs', status: 'pending', group: 'ratchets', what: 'walks server/' },
        { file: 'server/layering.test.js', status: 'pending', group: 'ratchets', what: 'walks server/' },
    ];
    const dir = fixture(BASE_FILES, { pendingBudget: 3, groups: GROUPS, entries });
    const r = check({ root: dir });
    assert.deepStrictEqual(r.missing, ['server/scripts/run.mjs']);
    assert.deepStrictEqual(r.stale, ['scripts/gone.mjs']);
    assert.deepStrictEqual(r.shape, []);
    assert.strictEqual(r.pending, 4);
    assert.strictEqual(main([], dir), 1);
}));

test('shapeErrors: status, what, reason for not-applicable, a known group for pending, sorted and unique', () => {
    const errors = shapeErrors({
        pendingBudget: 0,
        groups: GROUPS,
        entries: [
            { file: 'b', status: 'pending', what: 'x', group: 'nope' },
            { file: 'a', status: 'not-applicable', what: 'x' },
            { file: 'c', status: 'maybe', what: '' },
            { file: 'c', status: 'root-aware', what: 'x' },
        ],
    });
    assert.ok(errors.some((e) => e.startsWith('b: pending needs a "group"')));
    assert.ok(errors.some((e) => e.startsWith('a: not-applicable needs a "reason"')));
    assert.ok(errors.some((e) => e.startsWith('c: status "maybe"')));
    assert.ok(errors.some((e) => e.startsWith('c: "what" is empty')));
    assert.ok(errors.includes('listed twice: c'));
    assert.ok(errors.includes('entries are not sorted by file'));
});

test('--update lowers pendingBudget to the count and never raises it', () => defaultParents(() => {
    const entries = [
        { file: '.github/workflows/ci.yml', status: 'not-applicable', what: 'no paths', reason: 'push only' },
        { file: '.jscpd.json', status: 'root-aware', what: 'whole repo' },
        { file: 'scripts/walker.mjs', status: 'pending', group: 'ratchets', what: 'walks server/' },
        { file: 'server/layering.test.js', status: 'root-aware', what: 'walks every root' },
        { file: 'server/scripts/run.mjs', status: 'pending', group: 'ratchets', what: 'collects tests' },
    ];
    const dir = fixture(BASE_FILES, { pendingBudget: 5, groups: GROUPS, entries });
    assert.strictEqual(main(['--update'], dir), 0);
    assert.strictEqual(readInventory(dir).pendingBudget, 2);
    assert.deepStrictEqual(lowerBudget(dir), { from: 2, to: 2 });
    entries.push({ file: 'server/testUtils/plain.js', status: 'pending', group: 'ratchets', what: 'x' });
    const raised = { ...readInventory(dir), entries };
    fs.writeFileSync(path.join(dir, INVENTORY_REL), JSON.stringify(raised));
    assert.deepStrictEqual(lowerBudget(dir), { from: 2, to: 2 }, 'a count above the budget leaves the budget alone');
    assert.strictEqual(readInventory(dir).pendingBudget, 2);
    assert.strictEqual(main([], dir), 1);
}));
