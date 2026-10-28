import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addMark, completeOptionsEdits, forbiddenJsDoc, safeInferenceEdits, uselessQuickFix } from './jsdoc-convert-server.mjs';
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

test('a quick fix that writes a cast, a nothing-type or a guessed shape is refused', () => {
    assert.equal(uselessQuickFix('/** @type {string} */ ('), true);
    assert.equal(uselessQuickFix('/**\n * @param {null} v\n */\n'), true);
    assert.equal(uselessQuickFix('/**\n * @param {{ definition: undefined; }} updates\n */\n'), true);
    assert.equal(uselessQuickFix('/** @type {{ rows?: never[] | undefined; }} */ args'), true);
    assert.equal(uselessQuickFix('/**\n * @param {{}} node\n */\n'), true);
    assert.equal(uselessQuickFix('/**\n * @param {string} name\n * @param {{ id: string; }} row\n */\n'), false);
});

test('an inference edit with a forbidden type goes together with the edit that names it', () => {
    const edits = [
        { kind: 'interface', name: 'Args', members: [{ key: 'deps', type: '{ gate?: Function }' }] },
        { kind: 'param', name: null, index: 0, type: 'Args', host: 0 },
        { kind: 'param', name: 'n', index: 1, type: 'number', host: 0 },
    ];
    const { edits: kept, dropped } = safeInferenceEdits(edits);
    assert.deepEqual(kept, [edits[2]]);
    assert.equal(dropped.length, 2);
});

test('a typedef that leaves a destructured name untyped is dropped with its @param; a complete one stays', () => {
    const edits = [
        { kind: 'interface', name: 'BuildArgs', members: [{ key: 'id', type: 'string' }], open: ['extra'] },
        { kind: 'param', name: null, index: 0, type: 'BuildArgs', host: 0 },
        { kind: 'interface', name: 'RunArgs', members: [{ key: 'a', type: 'number' }], open: [] },
        { kind: 'param', name: null, index: 0, type: 'RunArgs', host: 40 },
        { kind: 'param', name: 'n', index: 1, type: 'number', host: 40 },
    ];
    const { edits: kept, dropped } = completeOptionsEdits(edits);
    assert.deepEqual(kept, edits.slice(2));
    assert.deepEqual(dropped, ['interface BuildArgs (typedef leaves extra untyped)', 'param BuildArgs (typedef leaves members untyped)']);
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

test('end to end on CommonJS: an options object with an untyped member gets no typedef (the file would otherwise stop passing the typecheck)', { skip: !ts && 'agent-hub typescript not installed' }, () => {
    const dir = '/virtual/server2';
    const files = new Map([
        [`${dir}/build.js`, "'use strict';\n/** @param {string} name */\nfunction greet(name) { return name; }\nfunction build({ id, extra }) { greet(id); return extra.x; }\nmodule.exports = { build };\n"],
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
    const f = `${dir}/build.js`;
    const inf = inferFile(ts, service, f);
    const typedef = inf.edits.find((e) => e.kind === 'interface' && e.name === 'BuildArgs');
    assert.ok(typedef, 'the inference proposes a typedef for the options object');
    assert.deepEqual(typedef.open, ['extra']);
    assert.deepEqual(typedef.members.map((m) => m.key), ['id']);
    // Unfiltered, the typedef lands and the destructure reads a member it lacks (TS2339).
    const raw = applyEdits(files.get(f), lowerToJsDoc(files.get(f), inf.edits).edits);
    assert.match(raw, /@typedef \{Object\} BuildArgs/);
    // Filtered, the slot stays open and the file is left as it was.
    const { edits: kept } = completeOptionsEdits(inf.edits);
    const out = applyEdits(files.get(f), lowerToJsDoc(files.get(f), kept).edits);
    assert.doesNotMatch(out, /BuildArgs/);
});
