import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commentFor, expressTypeFor, run } from './jsdoc-express-params.mjs';
import { insertAll, keepHarmless } from './lib/server-service.mjs';
import { createRequire } from 'node:module';

// The run() tests drive the TypeScript language service from agent-hub's
// node_modules; a job without them (the policy job) skips those tests only.
let hasTs = false;
try { createRequire(new URL('../agent-hub/package.json', import.meta.url))('typescript'); hasTs = true; } catch { /* not installed */ }
const tsTest = hasTs ? test : test.skip;

test('expressTypeFor: the shape of the parameter list decides, not the name alone', () => {
    assert.equal(expressTypeFor('req', ['req', 'res']), "import('express').Request");
    assert.equal(expressTypeFor('res', ['req', 'res', 'next']), "import('express').Response");
    assert.equal(expressTypeFor('next', ['req', 'res', 'next']), "import('express').NextFunction");
    assert.equal(expressTypeFor('err', ['err', 'req', 'res', 'next']), 'Error');
    assert.equal(expressTypeFor('req', ['req', 'res', 'next', 'extra']), "import('express').Request");
    assert.equal(expressTypeFor('err', ['err', 'cb']), null);
    assert.equal(expressTypeFor('req', ['req']), null, 'a lone req is not a handler');
    assert.equal(expressTypeFor('res', ['res']), null);
    assert.equal(expressTypeFor('next', ['next']), null);
    assert.equal(commentFor('Error'), '/** @type {Error} */ ');
});

test('keepHarmless: all edits when the count does not rise, else one by one, last position first', () => {
    const edits = [{ at: 0, text: 'A' }, { at: 2, text: 'B' }];
    // pretend a B anywhere is an extra diagnostic
    const count = (text) => (text.includes('B') ? 5 : 1);
    const r = keepHarmless('xyz', edits, count);
    assert.deepEqual(r.kept, [{ at: 0, text: 'A' }]);
    assert.equal(r.text, 'Axyz');
    assert.equal(insertAll('xyz', edits), 'AxyBz');
    assert.deepEqual(keepHarmless('xyz', edits, () => 1).kept, edits);
});

/** A server root of its own: a jsconfig, a stub for express's types and one file. */
function sandbox(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'express-params-'));
    mkdirSync(path.join(dir, 'types'));
    writeFileSync(path.join(dir, 'jsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'es2023', lib: ['es2023'], module: 'node20', moduleResolution: 'node16', allowJs: true, checkJs: true, noEmit: true, strict: false, types: [] },
        include: ['*.js', 'types/*.d.ts'],
    }));
    writeFileSync(path.join(dir, 'types/express.d.ts'), "declare module 'express' { export interface Request { params: Record<string, string>; user?: { id: string } } export interface Response { json(b: unknown): void } export type NextFunction = () => void }\n");
    for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
    return dir;
}

tsTest('a detached handler gets its Express types, and an edit that adds an error is dropped', () => {
    const dir = sandbox({
        'handlers.js': "function getUser(req, res) {\n    res.json({ id: req.params.id, me: req.user.id });\n}\nfunction odd(req, res) {\n    return req.nothing;\n}\nmodule.exports = { getUser, odd };\n",
    });
    try {
        const report = run({ files: [path.join(dir, 'handlers.js')], write: true, serverDir: dir });
        const text = readFileSync(path.join(dir, 'handlers.js'), 'utf8');
        assert.match(text, /function getUser\(\/\*\* @type \{import\('express'\)\.Request\} \*\/ req, \/\*\* @type \{import\('express'\)\.Response\} \*\/ res\)/);
        assert.ok(report[0].kept >= 2);
        // `odd` reads a field Request does not have: typing `req` would add an error, so only `res` is typed
        assert.match(text, /function odd\(req, \/\*\* @type \{import\('express'\)\.Response\} \*\/ res\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
