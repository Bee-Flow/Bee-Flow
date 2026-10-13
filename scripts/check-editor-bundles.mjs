#!/usr/bin/env node
/**
 * The generated editor bundles must be the build of their current sources.
 *
 * server/core/markdown/editorSerialization.cjs and editorCollab.cjs are
 * esbuild bundles of agent-hub/src/editor/**. Each carries a sha256 of its
 * inputs in its banner (scripts/build-editor-bundles.mjs writes it). This
 * recomputes that hash from the sources and fails when it differs: someone
 * changed the editor and did not rebuild, so the server still runs the old one.
 *
 * Needs no install: node:* only, and the bundle names its own inputs.
 * Fix: cd server && npm run build:editor-md && npm run build:editor-collab
 * Run: npm run lint:editor-bundles
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { BUNDLES, checkBundle } from './lib/editor-bundles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {string[]} one message per stale or unreadable bundle; empty when all are fresh */
export function check(serverDir = path.join(ROOT, 'server'), log = console.log) {
    const problems = [];
    for (const name of Object.keys(BUNDLES)) {
        const r = checkBundle(name, serverDir);
        if (r.ok) log(r.message);
        else problems.push(r.message);
    }
    return problems;
}

if (isEntryPoint(import.meta.url)) {
    const problems = check();
    for (const p of problems) console.error(`editor-bundles: ${p}`);
    if (problems.length && process.env.GITHUB_ACTIONS) console.log('::error::generated editor bundle is stale (see log)');
    process.exit(problems.length ? 1 : 0);
}
