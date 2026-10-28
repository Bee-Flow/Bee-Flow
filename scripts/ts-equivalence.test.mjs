import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, hasEsbuild, normalise, stripJsDocCasts } from './ts-equivalence.mjs';

const skip = hasEsbuild() ? false : 'server/ esbuild is not installed (cd server && npm ci)';

test('types, the React import and import extensions do not count as a difference', { skip }, async () => {
    const js = `import React from 'react';\nimport { x } from './x.jsx';\n// note\nexport default function A({ a }) { return <b>{x(a)}</b>; }\n`;
    const ts = `import { x } from './x';\ninterface Props { a: string }\n/** doc */\nexport default function A({ a }: Props): JSX.Element { return <b>{x(a as string)}</b>; }\n`;
    assert.deepEqual(await compile(js), await compile(ts));
});

test('a changed expression is a difference', { skip }, async () => {
    const js = `export const f = (xs) => xs.filter(Boolean);\n`;
    const ts = `export const f = (xs: unknown[]) => xs.filter((x) => Boolean(x));\n`;
    assert.notDeepEqual(await compile(js), await compile(ts));
});

test('normalise keeps a URL that contains //', () => {
    assert.deepEqual(normalise(`const u = 'https://a.b/c'; // trailing\n`), [`const u = 'https://a.b/c';`]);
});

test('a JSDoc cast is a comment plus parentheses: not a difference, however esbuild lays the call out', { skip }, async () => {
    const plain = 'function f(err, e) { if (!/x/i.test(err.message)) throw err; log.warn("a", e.message); }\n';
    const cast = 'function f(err, e) { if (!/x/i.test(/** @type {Error} */ (err).message)) throw err; log.warn("a", /** @type {{ message: string }} */ (e).message); }\n';
    assert.deepEqual(await compile(cast), await compile(plain));
    assert.equal(stripJsDocCasts(cast), 'function f(err, e) { if (!/x/i.test((err).message)) throw err; log.warn("a", (e).message); }\n');
    // a @type on a declaration (no parenthesis after it) is not a cast and stays
    assert.equal(stripJsDocCasts('/** @type {number} */ let n = 1;\n'), '/** @type {number} */ let n = 1;\n');
});
