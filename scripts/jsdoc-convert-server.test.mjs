import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMark, forbiddenJsDoc } from './jsdoc-convert-server.mjs';
import { lowerToJsDoc } from './jsdoc-lower.mjs';
import { applyEdits, inferFile, resetCaches, setSiteFilter } from './ts-callsite-types.mjs';

test('JSDoc may not say any, *, ? or Function, nor carry a ts-comment', () => {
    assert.equal(forbiddenJsDoc('/** @param {any} a */'), true);
    assert.equal(forbiddenJsDoc('/** @param {Array<any>} a */'), true);
    assert.equal(forbiddenJsDoc('/** @type {*} */'), true);
    assert.equal(forbiddenJsDoc('/** @param {Function} cb */'), true);
    assert.equal(forbiddenJsDoc('// @ts-ignore'), true);
    assert.equal(forbiddenJsDoc('/** @param {string} company */'), false);
});

test('the @typecheck mark goes on top, after a shebang, and only once', () => {
    assert.equal(addMark("'use strict';\n"), "// @typecheck\n'use strict';\n");
    assert.equal(addMark('#!/usr/bin/env node\nx();\n'), '#!/usr/bin/env node\n// @typecheck\nx();\n');
    assert.equal(addMark('// @typecheck\nx();\n'), '// @typecheck\nx();\n');
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ts = null;
try { ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript'); } catch { /* not installed */ }

test('end to end on CommonJS: a JavaScript caller types the parameter, as JSDoc', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const dir = '/virtual/server';
    const files = new Map([
        [`${dir}/greet.js`, "'use strict';\nfunction greet(name, times) { return name.repeat(times); }\nmodule.exports = { greet };\n"],
        [`${dir}/use.js`, "'use strict';\nconst { greet } = require('./greet');\ngreet('hi', 2);\n"],
    ]);
    const options = { allowJs: true, checkJs: true, noImplicitAny: true, module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, target: ts.ScriptTarget.ES2022, noEmit: true, types: [] };
    const host = {
        getScriptFileNames: () => [...files.keys()], getScriptVersion: () => '1',
        getScriptSnapshot: (f) => (files.has(f) ? ts.ScriptSnapshot.fromString(files.get(f)) : ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f)) : undefined),
        getCurrentDirectory: () => dir, getCompilationSettings: () => options, getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (f) => files.has(f) || ts.sys.fileExists(f), readFile: (f) => files.get(f) ?? ts.sys.readFile(f),
    };
    const service = ts.createLanguageService(host);
    setSiteFilter((f) => !/\.test\.[cm]?js$/.test(f));
    resetCaches();
    const f = `${dir}/greet.js`;
    const inf = inferFile(ts, service, f);
    const { edits } = lowerToJsDoc(files.get(f), inf.edits);
    const out = applyEdits(files.get(f), edits);
    assert.match(out, /\/\*\*\n \* @param \{string\} name\n \* @param \{number\} times\n \*\/\nfunction greet\(name, times\)/);
    assert.doesNotMatch(out, /: string|: number/); // no TypeScript syntax in a .js file
});
