/**
 * What is worth testing here is the DISCRIMINATION, not the arithmetic: the
 * scanner has to separate a test that asserts on source text from one that
 * merely happens to read a file. Get that wrong in the permissive direction
 * and fase 2 punt 8 looks bigger than it is; get it wrong in the strict
 * direction and the progress table quietly over-reports.
 *
 * Sandbox style is the one scripts/eslint-budget.test.mjs uses: a throwaway
 * git repo under os.tmpdir() with the real script copied in. It has to be a
 * real repo because the scanner takes its file list from `git ls-files`,
 * which is how it stays out of node_modules without maintaining an ignore
 * list.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'source-text-tests.mjs');

/** A throwaway repo holding `files` (path → contents), with the script in it. */
function sandbox(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-text-'));
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/source-text-tests.mjs'));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@example.test');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    return dir;
}

function run(dir, args = ['srv']) {
    const out = execFileSync('node', ['scripts/source-text-tests.mjs', ...args], { cwd: dir, encoding: 'utf8' });
    const m = out.match(/^(\d+) files, (\d+) source-text assertions/m);
    assert.ok(m, `no summary line in:\n${out}`);
    return { files: Number(m[1]), assertions: Number(m[2]), out };
}

test('an assertion on a variable read from disk is counted', () => {
    const dir = sandbox({
        'srv/a.test.js': `
const src = readFileSync('./a.js', 'utf8');
assert.match(src, /somePattern/);
assert.ok(src.includes('other'));
`,
    });
    const { files, assertions } = run(dir);
    assert.strictEqual(files, 1);
    assert.strictEqual(assertions, 2);
});

test('reading a file is not enough — the assertions must be ABOUT it', () => {
    // A fixture loader: the file is read to feed the subject, and every
    // assertion is about what the subject did with it. Counting this would
    // inflate the number with tests that are already behavioural.
    const dir = sandbox({
        'srv/b.test.js': `
const wav = readFileSync('./fixture.wav');
const result = await decode(wav);
assert.strictEqual(result.channels, 2);
assert.ok(result.duration > 0);
`,
    });
    assert.strictEqual(run(dir).files, 0);
});

test('JSON.parse(readFileSync(...)) holds parsed data, not source text', () => {
    // Reading a file to feed JSON.parse and then asserting on the parsed
    // value is behavioural — it is no different from getting that value from
    // any other API. Only the raw text case (matched against a regex) is a
    // source-text assertion.
    const dir = sandbox({
        'srv/g.test.js': `
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
assert.deepStrictEqual(pkg.dependencies, {});
`,
    });
    assert.strictEqual(run(dir).files, 0);
});

test('the JSON.parse exemption survives a fs. prefix and a .toString() hop', () => {
    const dir = sandbox({
        'srv/h.test.js': `
const spec = JSON.parse(fs.readFileSync('./component.json').toString('utf8'));
assert.strictEqual(spec.name, 'Probe');
`,
    });
    assert.strictEqual(run(dir).files, 0);
});

test('the JSON.parse exemption covers a template-literal hop', () => {
    const dir = sandbox({
        'srv/i.test.js': `
const spec = JSON.parse(\`\${readFileSync('./component.json', 'utf8')}\`);
assert.strictEqual(spec.name, 'Probe');
`,
    });
    assert.strictEqual(run(dir).files, 0);
});

test('a raw text read still counts even when a JSON.parse elsewhere reads a different file', () => {
    // The exemption is per assignment, not per file: a genuine source-text
    // match must not hide behind an unrelated JSON.parse nearby.
    const dir = sandbox({
        'srv/j.test.js': `
const cfg = JSON.parse(readFileSync('./config.json', 'utf8'));
const src = readFileSync('./a.js', 'utf8');
assert.ok(cfg.enabled);
assert.match(src, /somePattern/);
`,
    });
    assert.strictEqual(run(dir).assertions, 1);
});

test('a test with no file read at all is never counted', () => {
    const dir = sandbox({
        'srv/c.test.js': 'assert.strictEqual(add(1, 2), 3);\n',
    });
    assert.strictEqual(run(dir).files, 0);
});

test('one multi-line assertion counts once, not once per line', () => {
    // The unit is the claim. A pretty-printed assert.match spanning four
    // lines is one thing a maintainer has to replace, not four.
    const dir = sandbox({
        'srv/d.test.js': `
const src = readFileSync('./d.js', 'utf8');
assert.match(
    src,
    /a very long pattern that needed wrapping/,
    'the message is on its own line too'
);
`,
    });
    assert.strictEqual(run(dir).assertions, 1);
});

test('only the named roots are scanned', () => {
    const dir = sandbox({
        'srv/e.test.js': "const s = readFileSync('x');\nassert.match(s, /y/);\n",
        'other/f.test.js': "const s = readFileSync('x');\nassert.match(s, /y/);\n",
    });
    assert.strictEqual(run(dir, ['srv']).files, 1);
    assert.strictEqual(run(dir, ['srv', 'other']).files, 2);
});

test('--list names the files worst-first so the next one to convert is obvious', () => {
    const dir = sandbox({
        'srv/small.test.js': "const s = readFileSync('x');\nassert.match(s, /a/);\n",
        'srv/big.test.js': "const s = readFileSync('x');\nassert.match(s, /a/);\nassert.match(s, /b/);\nassert.match(s, /c/);\n",
    });
    const { out } = run(dir, ['srv', '--list']);
    assert.ok(out.indexOf('srv/big.test.js') < out.indexOf('srv/small.test.js'), 'the worst file is listed first');
});

test('a mistyped root is refused rather than reported as zero', () => {
    // Zero is the goal state of this metric, so a typo in the path must never
    // be able to look like success — which is exactly what an empty
    // `git ls-files` would otherwise produce.
    const dir = sandbox({ 'srv/a.test.js': 'assert.ok(true);\n' });
    assert.throws(
        () => execFileSync('node', ['scripts/source-text-tests.mjs', 'srvv'], { cwd: dir, stdio: 'pipe' }),
        /no such directory/,
    );
});

test('no root at all is a usage error', () => {
    const dir = sandbox({ 'srv/a.test.js': 'assert.ok(true);\n' });
    assert.throws(
        () => execFileSync('node', ['scripts/source-text-tests.mjs'], { cwd: dir, stdio: 'pipe' }),
        /usage:/,
    );
});

/** Like run(), but for the gate: it has to be able to fail, so keep the exit code. */
function gate(dir, args) {
    try {
        const stdout = execFileSync('node', ['scripts/source-text-tests.mjs', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

const budgetOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'srv/.source-text-ratchet.json'), 'utf8')).assertions;
const TWO = "const s = readFileSync('x');\nassert.match(s, /a/);\nassert.match(s, /b/);\n";

test('--gate fails when a change adds source-text assertions over the budget', () => {
    const dir = sandbox({ 'srv/a.test.js': TWO, 'srv/.source-text-ratchet.json': JSON.stringify({ assertions: 1 }) });
    const r = gate(dir, ['srv', '--gate']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /2 source-text assertions, budget is 1/);
});

test('--gate passes at or under the budget', () => {
    const at = sandbox({ 'srv/a.test.js': TWO, 'srv/.source-text-ratchet.json': JSON.stringify({ assertions: 2 }) });
    assert.strictEqual(gate(at, ['srv', '--gate']).code, 0);
    const under = sandbox({ 'srv/a.test.js': TWO, 'srv/.source-text-ratchet.json': JSON.stringify({ assertions: 7 }) });
    const r = gate(under, ['srv', '--gate']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /under the budget of 7/);
});

test('--update lowers the budget and never raises it', () => {
    const lower = sandbox({ 'srv/a.test.js': TWO, 'srv/.source-text-ratchet.json': JSON.stringify({ assertions: 9 }) });
    assert.strictEqual(gate(lower, ['srv', '--update']).code, 0);
    assert.strictEqual(budgetOf(lower), 2);

    const higher = sandbox({ 'srv/a.test.js': TWO, 'srv/.source-text-ratchet.json': JSON.stringify({ assertions: 1 }) });
    assert.strictEqual(gate(higher, ['srv', '--update']).code, 0);
    assert.strictEqual(budgetOf(higher), 1, 'an --update must not become a quiet way to raise the budget');
});

test('a missing budget file is written from the first measurement', () => {
    const dir = sandbox({ 'srv/a.test.js': TWO });
    assert.strictEqual(gate(dir, ['srv', '--gate']).code, 0);
    assert.strictEqual(budgetOf(dir), 2);
});

test('the gate takes exactly one directory, because the budget file lives in it', () => {
    const dir = sandbox({ 'srv/a.test.js': TWO, 'other/b.test.js': TWO });
    const r = gate(dir, ['srv', 'other', '--gate']);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /exactly one directory/);
});
