/**
 * The React component block's compiler (compile.mjs), with the native esbuild
 * the server compiles with on every page save.
 *
 * Run: node --test shared/cmsReact/compile.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    ALLOWED_IMPORTS, FIELD_TYPES, REACT_THEME_VARS, compileReactBlock, isPropName, utf8Bytes,
} from './compile.mjs';

const esbuild = createRequire(import.meta.url)('esbuild');

const COUNTER = [
    "import { useState } from 'react';",
    'export default function Counter({ start }: { start: number }) {',
    '  const [n, setN] = useState(start);',
    '  return <button onClick={() => setN(n + 1)}>{n}</button>;',
    '}',
].join('\n');

test('a component compiles to a CommonJS body that requires react and exports default', async () => {
    const res = await compileReactBlock(esbuild, COUNTER);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.diagnostics, []);
    assert.match(res.code, /require\("react"\)/);
    assert.match(res.code, /require\("react\/jsx-runtime"\)/);
    assert.match(res.code, /module\.exports/);
    // The CommonJS body runs with the runtime's require and yields the component.
    const module = { exports: {} };
    const fakeReact = { useState: (v) => [v, () => {}] };
    const jsx = { jsx: (type, props) => ({ type, props }) };
    new Function('module', 'exports', 'require', res.code)(module, module.exports, (id) => (id === 'react' ? fakeReact : jsx));
    assert.equal(typeof module.exports.default, 'function');
    assert.equal(module.exports.default({ start: 3 }).props.children, 3);
});

test('an import outside the allowed list is a compile error that names the allowed ones, with its position', async () => {
    const res = await compileReactBlock(esbuild, "import _ from 'lodash';\nexport default () => _.noop();");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /"lodash" cannot be imported here/);
    for (const name of ALLOWED_IMPORTS) assert.ok(res.error.includes(name), name);
    assert.equal(res.diagnostics[0].line, 1);
    assert.match(res.error, /^component\.tsx:1:\d+: /);
});

test('a file without a default export is refused', async () => {
    const res = await compileReactBlock(esbuild, 'export function Block() { return null; }');
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /no default export/);
});

test('a syntax error reports line (1-based) and column (0-based) and a formatted message', async () => {
    const res = await compileReactBlock(esbuild, 'export default function A() {\n  return <p>{a</p>;\n}');
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.diagnostics[0].line, 2);
    assert.ok(res.diagnostics[0].column >= 0);
    assert.match(res.error, /^component\.tsx:2:\d+: /);
});

test('the size limit counts UTF-8 bytes; 0 means no limit; an empty source says what to write', async () => {
    const big = `export default () => ${JSON.stringify('é'.repeat(60))};`;
    const over = await compileReactBlock(esbuild, big, { maxSourceBytes: 100 });
    assert.equal(over.ok, false);
    if (!over.ok) assert.match(over.error, /larger than 100 bytes.*CMS_REACT_SOURCE_MAX_BYTES/);
    assert.equal((await compileReactBlock(esbuild, big, { maxSourceBytes: 0 })).ok, true);
    const empty = await compileReactBlock(esbuild, '   ');
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.error, /no code yet/);
    assert.equal(utf8Bytes('é€😀a'), 2 + 3 + 4 + 1);
});

test('prop names, field types and theme variables', () => {
    assert.ok(isPropName('title') && isPropName('_x1') && isPropName('$y'));
    assert.ok(!isPropName('1x') && !isPropName('a-b') && !isPropName('') && !isPropName('x'.repeat(41)) && !isPropName(3));
    assert.deepEqual([...FIELD_TYPES], ['text', 'textarea', 'number', 'boolean', 'color', 'image', 'link', 'select']);
    assert.ok(REACT_THEME_VARS.includes('--bf-primary') && REACT_THEME_VARS.includes('--bf-radius'));
    assert.ok(REACT_THEME_VARS.every((v) => v.startsWith('--bf-')));
});
