import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { INSTALL_HINT, ROOT, TS_API_PACKAGE, isFullApi, loadTsApi, skipWithoutTsApi, tryTsApi } from './lib/ts-api.mjs';

const installed = fs.existsSync(path.join(ROOT, 'node_modules', TS_API_PACKAGE, 'package.json'));

test('TypeScript 7 is not the API: its require() is a version stub', () => {
    assert.strictEqual(isFullApi({ version: '7.0.2' }), false);
    assert.strictEqual(isFullApi(null), false);
    assert.strictEqual(isFullApi({ createSourceFile() {}, createProgram() {} }), true);
});

test('the root package.json pins typescript-api to TypeScript 6', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const spec = { ...pkg.dependencies, ...pkg.devDependencies }[TS_API_PACKAGE];
    assert.match(spec ?? '', /^npm:typescript@\^?6\./, `${TS_API_PACKAGE} must be an alias of typescript 6, got ${spec}`);
});

test('with the root installed, the API loads and is TypeScript 6', { skip: !installed && INSTALL_HINT }, () => {
    const ts = loadTsApi();
    assert.ok(isFullApi(ts));
    assert.match(ts.version, /^6\./);
    assert.strictEqual(tryTsApi(), ts, 'cached');
    assert.strictEqual(skipWithoutTsApi(), false);
});

test('no script outside lib/ts-api.mjs loads a package `typescript` for its API', () => {
    const dir = path.join(ROOT, 'scripts');
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'lib')).map((f) => path.join(dir, 'lib', f))]
        .filter((f) => /\.m?js$/.test(f) && !f.endsWith(path.join('lib', 'ts-api.mjs')) && path.basename(f) !== 'ts-api.test.mjs');
    // createRequire(<somewhere>)('typescript'): the shape every loader had before ts-api.mjs.
    const offenders = files.filter((f) => /createRequire\([^)]*\)\)?\(\s*['"]typescript['"]\s*\)/.test(fs.readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders.map((f) => path.relative(ROOT, f)), [], 'use loadTsApi() / tryTsApi() from scripts/lib/ts-api.mjs');
});
