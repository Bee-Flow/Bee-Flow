#!/usr/bin/env node
/**
 * Builds the generated editor bundles in server/core/markdown/ with the
 * esbuild the server's lockfile pins (no `npx -y`, which fetched whatever
 * esbuild was newest) and stamps each with a hash of its inputs.
 *
 *   node scripts/build-editor-bundles.mjs md|collab     (cd server && npm run build:editor-md / build:editor-collab)
 *
 * Two passes: the first learns the inputs from esbuild's metafile, the second
 * writes the bundle with the hash in its banner. See lib/editor-bundles.mjs.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { BUNDLES, bannerFor, hashInputs } from './lib/editor-bundles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');

function loadEsbuild() {
    try {
        return createRequire(path.join(SERVER, 'package.json'))('esbuild');
    } catch {
        throw new Error('esbuild is not installed for the server; run: cd server && npm ci');
    }
}

export async function build(name, { esbuild = loadEsbuild(), baseDir = SERVER } = {}) {
    const b = BUNDLES[name];
    if (!b) throw new Error(`unknown bundle "${name}" (${Object.keys(BUNDLES).join(', ')})`);
    const common = {
        absWorkingDir: baseDir,
        entryPoints: [b.entry],
        outfile: b.out,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        logLevel: 'warning',
        ...b.options,
    };
    const first = await esbuild.build({ ...common, write: false, metafile: true });
    const inputs = Object.keys(first.metafile.inputs);
    const hash = hashInputs(baseDir, inputs);
    await esbuild.build({
        ...common,
        banner: { js: bannerFor(name, hash, inputs) },
        ...(b.footer ? { footer: { js: b.footer } } : {}),
    });
    return { out: b.out, hash, inputs: inputs.length };
}

if (isEntryPoint(import.meta.url)) {
    try {
        const r = await build(process.argv[2]);
        console.log(`${r.out}: ${r.inputs} inputs, inputs-sha256 ${r.hash.slice(0, 12)}`);
    } catch (e) {
        console.error(`build-editor-bundles: ${e.message}`);
        process.exit(1);
    }
}
