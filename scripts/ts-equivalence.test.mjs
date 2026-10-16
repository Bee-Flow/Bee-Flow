import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, hasEsbuild, normalise } from './ts-equivalence.mjs';

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
