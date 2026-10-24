/**
 * ts-outline: the outline has to say what a declaration needs (so an agent
 * need not read the file) and which groups can move without importing back.
 * Fixtures live in a throwaway directory under os.tmpdir().
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { format, outline } from './ts-outline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-outline-'));
    for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
}

const ESM_TS = `// @typecheck
import { readFile } from 'node:fs/promises';
import type { Row } from './row';

/** Parses one line. */
export function parseLine(line: string): string[] {
    return splitCells(line).map(trim);
}

function splitCells(line: string): string[] {
    return line.split(SEP);
}

const SEP = ',';

const trim = (s: string) => s.trim();

export interface Options { strict: boolean }

type Local = Options & { extra?: number };

export async function load(file: string, opts: Local): Promise<Row[]> {
    const text = await readFile(file, 'utf8');
    return text.split('\\n').map((l) => ({ cells: parseLine(l), strict: opts.strict }));
}

function unrelated(param: number) {
    const SEP = 'shadow';
    return param + SEP.length;
}

export function lonely() { return unrelated(1); }
`;

test('lists declarations with kind, lines, export flag, references and imports', () => {
    const dir = fixture({ 'csv.ts': ESM_TS });
    const o = outline(path.join(dir, 'csv.ts'));
    const by = Object.fromEntries(o.declarations.map((d) => [d.name, d]));
    assert.equal(o.module, 'esm');
    assert.equal(o.typecheck, '// @typecheck');
    assert.equal(by.parseLine.kind, 'fn');
    assert.equal(by.parseLine.exported, true);
    assert.equal(by.parseLine.from, 5, 'the JSDoc line belongs to the declaration');
    assert.deepEqual(by.parseLine.refs.sort(), ['splitCells', 'trim']);
    assert.deepEqual(by.splitCells.refs, ['SEP']);
    assert.deepEqual(by.load.imports.sort(), ['Row', 'readFile']);
    assert.ok(by.load.refs.includes('parseLine') && by.load.refs.includes('Local'));
    assert.equal(by.Options.kind, 'interface');
    assert.equal(by.Local.exported, false);
});

test('a local that shadows a top-level name is not a reference', () => {
    const dir = fixture({ 'csv.ts': ESM_TS });
    const o = outline(path.join(dir, 'csv.ts'));
    const unrelated = o.declarations.find((d) => d.name === 'unrelated');
    assert.deepEqual(unrelated.refs, [], 'the inner const SEP is its own');
});

test('closed clusters: independent groups, and the support of a root', () => {
    const dir = fixture({ 'csv.ts': ESM_TS });
    const o = outline(path.join(dir, 'csv.ts'));
    const names = o.clusters.map((c) => c.members.join(','));
    assert.ok(names.some((m) => m.includes('unrelated') && m.includes('lonely')), 'lonely + unrelated stand alone');
    const csv = o.clusters.find((c) => c.members.includes('parseLine'));
    assert.ok(csv.members.includes('SEP') && csv.members.includes('load'));
    assert.ok(!csv.members.includes('unrelated'));
    assert.deepEqual(csv.support.members.includes('load'), false, 'support leaves the root out');
    assert.ok(csv.support.members.includes('SEP'));
});

test('tests next to the file and mock factories are reported, per symbol', () => {
    const dir = fixture({
        'csv.ts': ESM_TS,
        'csv.test.ts': "import { parseLine } from './csv';\nvi.mock('./csv', () => ({ load: vi.fn() }));\n",
        'other.test.ts': "import { x } from './nothing';\n",
    });
    const o = outline(path.join(dir, 'csv.ts'));
    assert.deepEqual(o.tests.map((t) => t.file), ['csv.test.ts']);
    assert.equal(o.tests[0].mocksThisFile, true);
    const by = Object.fromEntries(o.declarations.map((d) => [d.name, d]));
    assert.deepEqual(by.parseLine.tests, ['t1m']);
    assert.deepEqual(by.splitCells.tests, []);
});

test('CommonJS: require bindings, module.exports keys and statements', () => {
    const dir = fixture({
        'schemas.js': `// @typecheck
const { A } = require('./a');
const HINT = 'x';
const PROPS = { hint: HINT };
const TOOLS = [ { p: PROPS, a: A } ];
TOOLS.push(...require('./more'));
module.exports = { TOOLS, HINT };
`,
        'schemas.test.js': "const { TOOLS } = require('./schemas');\nrequire.cache[require.resolve('./schemas')] = {};\n",
    });
    const o = outline(path.join(dir, 'schemas.js'));
    assert.equal(o.module, 'cjs');
    const by = Object.fromEntries(o.declarations.map((d) => [d.name, d]));
    assert.equal(by.TOOLS.exported, true);
    assert.equal(by.PROPS.exported, false);
    assert.deepEqual(by.TOOLS.imports, ['A']);
    assert.ok(o.declarations.some((d) => d.kind === 'stmt' && d.refs.includes('TOOLS')));
    assert.deepEqual(o.declarations.find((d) => d.kind === 'exports').exports, ['TOOLS', 'HINT']);
    assert.equal(o.tests[0].mocksThisFile, true, 'require.cache stub counts as a mock');
});

test('compact text and --json from the command line', () => {
    const dir = fixture({ 'csv.ts': ESM_TS });
    const text = execFileSync('node', [path.join(HERE, 'ts-outline.mjs'), path.join(dir, 'csv.ts')], { encoding: 'utf8' });
    assert.match(text, /fn parseLine 4E ->splitCells,trim/);
    assert.match(text, /closed clusters/);
    const json = JSON.parse(execFileSync('node', [path.join(HERE, 'ts-outline.mjs'), path.join(dir, 'csv.ts'), '--json'], { encoding: 'utf8' }));
    assert.ok(Array.isArray(json.declarations));
    assert.ok(format(json).length < 3000);
});

test('header warns about tests coupled to the file path (stub by requiring file, require.cache key, readFileSync)', () => {
    const dir = fixture({
        'x.js': 'function a() { return 1; }\nmodule.exports = { a };\n',
        'x.test.js': [
            "const Module = require('module');",
            'const orig = Module._resolveFilename;',
            'Module._resolveFilename = function (req, parent) {',
            "  if (parent.filename.endsWith('x.js')) return '/stub';",
            '  return orig.apply(this, arguments);',
            '};',
            "const src = require('fs').readFileSync(require('path').join(__dirname, 'x.js'), 'utf8');",
            "const { a } = require('./x');",
        ].join('\n'),
        'clean.js': 'function a() { return 1; }\nmodule.exports = { a };\n',
        'clean.test.js': "const { a } = require('./clean');\n",
    });
    const o = outline(path.join(dir, 'x.js'));
    assert.deepEqual(o.testCouplings.map((w) => w.kind).sort(), ['reads-source', 'resolve-by-parent']);
    assert.equal(o.testCouplings[0].file, 'x.test.js');
    const text = format(o);
    assert.match(text, /WARN test coupling x\.test\.js:4 \[resolve-by-parent\]/);
    assert.match(text, /WARN test coupling x\.test\.js:7 \[reads-source\]/);
    assert.deepEqual(outline(path.join(dir, 'clean.js')).testCouplings, []);
    assert.doesNotMatch(format(outline(path.join(dir, 'clean.js'))), /WARN/);
});
