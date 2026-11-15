/**
 * The environment inventory is a list and a gate. The list has to find a
 * variable however the server reads it (dot, bracket, destructuring, an env
 * helper with its default) and leave out what is not a read (a comment, a name
 * built at run time). The gate has to REFUSE: a new variable that no document
 * mentions, and an --update that would raise the budget.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main, readsOf, documentedWords, inventory, BUDGET_REL } from './env-inventory.mjs';

function sandbox({ files = {}, docs = {}, budget } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-inventory-'));
    const write = (rel, body) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    };
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) write(path.join('server', rel), body);
    for (const [rel, body] of Object.entries(docs)) write(rel, body);
    if (budget !== undefined) write(BUDGET_REL, JSON.stringify({ count: budget }));
    const lines = { out: '', err: '' };
    const run = (...argv) => main(argv, { root, today: '2026-01-01', out: (s) => { lines.out += s; }, err: (s) => { lines.err += s; } });
    return { root, run, lines, budget: () => JSON.parse(fs.readFileSync(path.join(root, BUDGET_REL), 'utf8')).count };
}

const names = (text) => readsOf(text).map((r) => r.name);

test('finds a variable read by dot, by a literal bracket and by destructuring', () => {
    assert.deepStrictEqual(names("const a = process.env.ALPHA || 'x';\nconst b = process.env['BRAVO'];\nconst c = process.env[\"CHARLIE\"];\n"), ['ALPHA', 'BRAVO', 'CHARLIE']);
    assert.deepStrictEqual(names("const { DELTA, ECHO: echo, FOXTROT = 'f' } = process.env;\n"), ['DELTA', 'ECHO', 'FOXTROT']);
});

test('finds a variable read through an env helper, with its default', () => {
    const reads = readsOf([
        "const rpm = envInt('STEP_RATE', 60, { min: 1 });",
        "const share = envNumber('MIN_SHARE', 0.6);",
        "const wait = envInt('WAIT_MS', 5 * 60_000);",
        "const cap = envCap('RUN_RPM', Math.max(DEFAULT_RPM, 30)) || 30;",
        "const max = envByteLimit('MAX_BYTES', DEFAULT_MAX);",
        "const flag = envFlagOn('SOME_FLAG');",
    ].join('\n'));
    assert.deepStrictEqual(reads, [
        { name: 'STEP_RATE', default: '60' },
        { name: 'MIN_SHARE', default: '0.6' },
        { name: 'WAIT_MS', default: '5 * 60_000' },
        { name: 'RUN_RPM', default: 'Math.max(DEFAULT_RPM, 30)' },
        { name: 'MAX_BYTES', default: 'DEFAULT_MAX' },
        { name: 'SOME_FLAG', default: null },
    ]);
});

test('leaves out a comment, a name built at run time and a name in an options object', () => {
    assert.deepStrictEqual(names([
        '// process.env.IN_A_LINE_COMMENT is not a read',
        '/* nor is process.env.IN_A_BLOCK_COMMENT, or envInt(\'COMMENTED\', 1) */',
        'const v = process.env[name];',
        'const w = process.env[`${prefix}_URL`];',
        "const limiter = spendLimiter({ env: 'DIRECT_CHAT_RPM', fallback: 60 });",
        "const env = process.env; const envelope = envelopeOf('NOT_ENV');",
        'const real = process.env.REAL;',
    ].join('\n')), ['REAL']);
});

test('a name is documented as a whole word only', () => {
    const words = documentedWords(['# FOO_BAR=1   what it does\n', '| `BAZ` | `40` | text |\n']);
    assert.ok(words.has('FOO_BAR'));
    assert.ok(words.has('BAZ'));
    assert.ok(!words.has('FOO'), 'FOO_BAR does not document FOO');
});

const FILES = {
    'index.js': "const port = process.env.PORT || 3001;\nconst hops = envInt('TRUST_PROXY_HOPS', 1, { min: 0 });\n",
    'core/a.mts': "export const ttl = envInt('CACHE_TTL_MS', 60_000);\nexport const mode = process.env.DEPLOY_MODE;\n",
    'core/b.js': "const ttl = envInt('CACHE_TTL_MS', 30_000);\nconst secret = process.env.SECRET_THING;\n",
    'core/b.test.js': 'process.env.ONLY_IN_A_TEST = "1";\n',
    'testUtils/env.js': 'process.env.ONLY_IN_A_TEST_KIT = "1";\n',
    'node_modules/dep/index.js': 'process.env.ONLY_IN_A_DEPENDENCY;\n',
};
const DOCS = {
    '.env.example': '# The HTTP port\nPORT=3001\n',
    'server/.env.example': '# TRUST_PROXY_HOPS=1   proxies in front of the server\n',
    'docs/docs/self-hosting/env.md': '| `DEPLOY_MODE` | `selfhost` | Which mode. |\n',
};

test('the inventory merges files and defaults, skips tests, test kits and dependencies, and reads all three documents', () => {
    const s = sandbox({ files: FILES, docs: DOCS });
    assert.deepStrictEqual(inventory(s.root), [
        { name: 'CACHE_TTL_MS', documented: false, defaults: ['60_000', '30_000'], files: ['core/a.mts', 'core/b.js'] },
        { name: 'DEPLOY_MODE', documented: true, defaults: [], files: ['core/a.mts'] },
        { name: 'PORT', documented: true, defaults: [], files: ['index.js'] },
        { name: 'SECRET_THING', documented: false, defaults: [], files: ['core/b.js'] },
        { name: 'TRUST_PROXY_HOPS', documented: true, defaults: ['1'], files: ['index.js'] },
    ]);
});

test('--list prints one line per variable: status, name, default and files', () => {
    const s = sandbox({ files: FILES, docs: DOCS, budget: 2 });
    assert.strictEqual(s.run('--list'), 0);
    assert.deepStrictEqual(s.lines.out.split('\n').filter(Boolean), [
        'undocumented  CACHE_TTL_MS  default 60_000 | 30_000  core/a.mts, core/b.js',
        'documented    DEPLOY_MODE  -  core/a.mts',
        'documented    PORT  -  index.js',
        'undocumented  SECRET_THING  -  core/b.js',
        'documented    TRUST_PROXY_HOPS  default 1  index.js',
    ]);
    assert.match(s.lines.err, /5 variables, 2 undocumented \(budget 2\)/);

    const only = sandbox({ files: FILES, docs: DOCS, budget: 2 });
    only.run('--list', '--undocumented');
    assert.deepStrictEqual(only.lines.out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]), ['CACHE_TTL_MS', 'SECRET_THING']);
});

test('the gate passes at and under the budget, and says when the budget can come down', () => {
    const at = sandbox({ files: FILES, docs: DOCS, budget: 2 });
    assert.strictEqual(at.run('--check'), 0);
    assert.match(at.lines.out, /^➖ server: 2 environment variables .*, at budget/);

    const under = sandbox({ files: FILES, docs: DOCS, budget: 5 });
    assert.strictEqual(under.run(), 0);
    assert.match(under.lines.out, /^✅ server: 2 environment variables .*, under the budget of 5/);
});

test('a new variable that no document mentions fails the gate and names where to document it', () => {
    const s = sandbox({ files: { ...FILES, 'routes/new.js': 'const x = process.env.FOO_TEST;\n' }, docs: DOCS, budget: 2 });
    assert.strictEqual(s.run('--check'), 1);
    assert.match(s.lines.err, /^❌ server: 3 environment variables .*, budget is 2/);
    assert.match(s.lines.err, /\.env\.example/);
    assert.match(s.lines.err, /--list --undocumented/);

    const documented = sandbox({
        files: { ...FILES, 'routes/new.js': 'const x = process.env.FOO_TEST;\n' },
        docs: { ...DOCS, 'server/.env.example': `${DOCS['server/.env.example']}# FOO_TEST=1   a new switch\n` },
        budget: 2,
    });
    assert.strictEqual(documented.run('--check'), 0, 'the same variable with a line in an example file passes');
});

test('--update lowers the budget, never raises it, and writes the first one', () => {
    const lower = sandbox({ files: FILES, docs: DOCS, budget: 9 });
    assert.strictEqual(lower.run('--update'), 0);
    assert.strictEqual(lower.budget(), 2);

    const raise = sandbox({ files: FILES, docs: DOCS, budget: 1 });
    assert.strictEqual(raise.run('--update'), 1);
    assert.strictEqual(raise.budget(), 1);
    assert.match(raise.lines.err, /--update only lowers it/);

    const first = sandbox({ files: FILES, docs: DOCS });
    fs.mkdirSync(path.dirname(path.join(first.root, BUDGET_REL)), { recursive: true });
    assert.strictEqual(first.run('--update'), 0);
    assert.strictEqual(first.budget(), 2);
});

test('a missing budget file is a failure, not a pass', () => {
    const s = sandbox({ files: FILES, docs: DOCS });
    assert.strictEqual(s.run(), 1);
    assert.match(s.lines.err, /is missing/);
});
