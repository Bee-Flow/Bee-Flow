/**
 * The index is only worth having if it is complete and true: every runnable script gets a row,
 * the row is the first sentence of its own header, a script without a header is refused, and
 * --check notices a stale table without writing anything.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { firstSentence, headerText, indexRows, renderIndex, run, withIndex } from './gen-scripts-index.mjs';

function sandbox(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripts-index-'));
    for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
}

/** run() with its output captured: { code, out, err }. */
function runIn(dir, check = false) {
    const out = [];
    const err = [];
    const code = run({ check, dir, log: (l) => out.push(l), error: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
}

const SCRIPTS = {
    'b-check.mjs': '#!/usr/bin/env node\n// @typecheck strict\n/**\n * Checks the thing. It has a second\n * sentence.\n *\n * Usage: node b-check.mjs\n */\nexport const x = 1;\n',
    'a-build.sh': '#!/usr/bin/env bash\n#\n# a-build.sh — Build the images | push them.\n#\n# Usage: ./a-build.sh\nset -e\n',
    'b-check.test.mjs': '/** Tests are not scripts. */\n',
    'notes.json': '{}',
    'lib/helper.mjs': '/** A helper in a sub-folder is not indexed. */\n',
};

test('headerText reads the first comment of each kind of script', () => {
    assert.strictEqual(headerText(SCRIPTS['b-check.mjs'], 'b-check.mjs'), 'Checks the thing. It has a second\nsentence.\n\nUsage: node b-check.mjs');
    assert.strictEqual(headerText("'use strict';\n// One line.\n// Two lines.\nconst a = 1;\n", 'x.cjs'), 'One line.\nTwo lines.');
    assert.strictEqual(headerText(SCRIPTS['a-build.sh'], 'a-build.sh'), 'a-build.sh — Build the images | push them.\n\nUsage: ./a-build.sh');
    assert.strictEqual(headerText('#!/usr/bin/env bash\nset -euo pipefail\n# After the options.\necho hi\n', 'x.sh'), 'After the options.');
    assert.strictEqual(headerText('<#\n  Builds on Windows.\n#>\nparam()\n', 'x.ps1'), 'Builds on Windows.');
});

test('a file that starts with code has no header', () => {
    assert.strictEqual(headerText("import fs from 'node:fs';\n// not a header\n", 'x.mjs'), '');
    assert.strictEqual(headerText('#!/usr/bin/env bash\nset -e\necho hi\n# later\n', 'x.sh'), '');
});

test('firstSentence stops at the end of the first sentence, and only there', () => {
    assert.strictEqual(firstSentence('Checks the thing. It has a second\nsentence.', 'x.mjs'), 'Checks the thing.');
    assert.strictEqual(firstSentence('Reads x.mjs files, e.g. `a.mjs`, from server/ ... And more. Then this.', 'y.mjs'),
        'Reads x.mjs files, e.g. `a.mjs`, from server/ ... And more.');
    assert.strictEqual(firstSentence('Does a file fetch in an effect? Yes.', 'x.mjs'), 'Does a file fetch in an effect?');
    assert.strictEqual(firstSentence('No full stop at all\n\nSecond paragraph.', 'x.mjs'), 'No full stop at all');
});

test('firstSentence drops the script\'s own name in front and the colon before a list', () => {
    assert.strictEqual(firstSentence('a-build.sh — Build the images.', 'a-build.sh'), 'Build the images.');
    assert.strictEqual(firstSentence('`a-build.sh`: build the images.', 'a-build.sh'), 'build the images.');
    assert.strictEqual(firstSentence('a-build.sh builds the images.', 'a-build.sh'), 'a-build.sh builds the images.');
    assert.strictEqual(firstSentence('Generates the copies:\n\n  - one\n  - two', 'x.mjs'), 'Generates the copies');
});

test('a long sentence is shortened at a word', () => {
    const long = `${'word '.repeat(60).trim()}.`;
    const short = firstSentence(long, 'x.mjs');
    assert.ok(short.length <= 222, String(short.length));
    assert.match(short, /word …$/);
});

test('the index holds every runnable script of the folder, sorted, and nothing else', () => {
    const rows = indexRows(sandbox(SCRIPTS));
    assert.deepStrictEqual(rows, [
        { name: 'a-build.sh', purpose: 'Build the images | push them.' },
        { name: 'b-check.mjs', purpose: 'Checks the thing.' },
    ]);
    assert.match(renderIndex(rows), /\| `a-build\.sh` \| Build the images \\\| push them\. \|\n\| `b-check\.mjs` \| Checks the thing\. \|/);
    // A placeholder outside a code span would be swallowed as an HTML tag; inside one it is text.
    assert.match(renderIndex([{ name: 'c.mjs', purpose: 'Reads steps/<kind>.js with `tsc -p <package>`.' }]),
        /Reads steps\/\\<kind>\.js with `tsc -p <package>`\. \|/);
});

test('the first run appends the section; the hand-written part of the README is kept', () => {
    const dir = sandbox({ ...SCRIPTS, 'README.md': '# scripts/\n\nWritten by hand.\n' });
    const first = runIn(dir);
    assert.strictEqual(first.code, 0);
    assert.match(first.out, /wrote 2 rows/);
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.ok(readme.startsWith('# scripts/\n\nWritten by hand.\n\n## Every script\n'));
    assert.match(readme, /\| `b-check\.mjs` \| Checks the thing\. \|\n<!-- scripts-index:end -->\n$/);
    assert.match(runIn(dir).out, /2 scripts, index up to date/);
    assert.strictEqual(runIn(dir, true).code, 0);
});

test('--check names the script whose row is missing or changed, and writes nothing', () => {
    const dir = sandbox({ ...SCRIPTS, 'README.md': '# scripts/\n' });
    runIn(dir);
    const before = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    fs.writeFileSync(path.join(dir, 'c-new.mjs'), '/** A new codemod. */\n');
    const added = runIn(dir, true);
    assert.strictEqual(added.code, 1);
    assert.match(added.err, /out of date \(c-new\.mjs\)/);
    assert.match(added.err, /npm run gen:scripts-index/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), before);

    fs.rmSync(path.join(dir, 'c-new.mjs'));
    fs.rmSync(path.join(dir, 'a-build.sh'));
    const removed = runIn(dir, true);
    assert.strictEqual(removed.code, 1);
    assert.match(removed.err, /a row for a script that is gone/);
});

test('a script without a header comment is refused by name, when writing and when checking', () => {
    const dir = sandbox({ ...SCRIPTS, 'README.md': '# scripts/\n', 'd-silent.mjs': "import fs from 'node:fs';\n" });
    for (const check of [false, true]) {
        const r = runIn(dir, check);
        assert.strictEqual(r.code, 1);
        assert.match(r.err, /no header comment in scripts\/d-silent\.mjs/);
    }
    assert.strictEqual(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# scripts/\n');
});

test('text after the generated block survives a rewrite', () => {
    const block = renderIndex([{ name: 'a.mjs', purpose: 'Old.' }]);
    const next = withIndex(`intro\n\n${block}\n\nafter\n`, renderIndex([{ name: 'a.mjs', purpose: 'New.' }]));
    assert.match(next, /^intro\n\n<!-- scripts-index:start/);
    assert.match(next, /\| `a\.mjs` \| New\. \|/);
    assert.ok(!next.includes('Old.'));
    assert.ok(next.endsWith('<!-- scripts-index:end -->\n\nafter\n'));
});
