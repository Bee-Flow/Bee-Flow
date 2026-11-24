// The TypeScript compiler JavaScript API for every repository script: ONE place.
//
// Every typecheck in the repository runs TypeScript 7 (the native compiler), but 7.0 has no
// JavaScript API: `require('typescript')` on 7 returns a version stub. The parsers, the
// language-service codemods and the ratchets that read an AST therefore use TypeScript 6,
// installed once, at the root, as the alias `typescript-api` (root package.json). No script
// reaches into agent-hub's (or another package's) `typescript`: that copy exists for
// typescript-eslint, and the version a package lints with is not the version a script parses with.
//
// Tests: `tryTsApi()` returns null where the root packages are not installed, so a test can
// skip (workflow-policy.yml runs test:scripts without `npm ci`). Where they are installed and
// the tests must run (ci.yml's fast-gates job), TS_API_REQUIRED=1 turns that skip into a failure,
// so a broken install cannot pass as "skipped".

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TS_API_PACKAGE = 'typescript-api';
export const INSTALL_HINT = `the TypeScript API (${TS_API_PACKAGE}, TypeScript 6) is not installed: run \`npm ci\` at the repository root`;

let cache;

/** Is `ts` the full compiler API, not TypeScript 7's version stub? */
export function isFullApi(ts) {
    return Boolean(ts) && typeof ts.createSourceFile === 'function' && typeof ts.createProgram === 'function';
}

/** The TypeScript 6 compiler API from the root's `typescript-api`. Throws with the install hint. */
export function loadTsApi() {
    if (cache) return cache;
    let ts;
    try {
        ts = createRequire(path.join(ROOT, 'package.json'))(TS_API_PACKAGE);
    } catch (e) {
        throw new Error(`${INSTALL_HINT}\n(${String(e.message).split('\n')[0]})`);
    }
    if (!isFullApi(ts)) throw new Error(`${TS_API_PACKAGE} ${ts?.version ?? '?'} has no compiler API (TypeScript 7?): it must stay on TypeScript 6`);
    cache = ts;
    return ts;
}

/** For tests: the API, or null to skip. With TS_API_REQUIRED=1 a missing API throws instead. */
export function tryTsApi(env = process.env) {
    try {
        return loadTsApi();
    } catch (e) {
        if (env.TS_API_REQUIRED === '1') throw e;
        return null;
    }
}

/** The skip reason for node:test, or false when the API is there. */
export function skipWithoutTsApi(env = process.env) {
    return tryTsApi(env) ? false : INSTALL_HINT;
}
