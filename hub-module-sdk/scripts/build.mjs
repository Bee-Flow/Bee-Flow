#!/usr/bin/env node
/**
 * build.mjs — compile a module's source into the packable layout.
 *
 * From a module dir laid out as:
 *   module.manifest.json          (authoring manifest)
 *   server/src/index.js           (exports createModule(host))
 *   frontend/src/App.jsx          (default-exports the Studio component) [optional]
 *   frontend/vite.config.js       (lib mode, react family externalised)   [optional]
 *   assets/…                                                              [optional]
 *
 * It produces:
 *   manifest.json                 (copied from module.manifest.json)
 *   server/entry.cjs              (esbuild: single self-contained CJS bundle,
 *                                  only node: builtins left external)
 *   frontend/index.js (+ .css)    (vite lib build, react family externalised)
 *
 * Then pack.mjs + sign.mjs turn that into a signed `.bfmod`.
 *
 * esbuild is a dependency of this SDK. vite is NOT — the frontend is built by
 * shelling out to `npx vite build` in the module's frontend/ dir, using the
 * module's own frontend/vite.config.js (see template/frontend/vite.config.js).
 * Install vite as a devDependency of the module, or run inside a workspace that
 * provides it.
 *
 * Usage:  node scripts/build.mjs <moduleDir> [--skip-frontend]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

// Per-module esbuild `bfmod` config in the module's package.json:
//   external: string[]  — deps left as runtime requires (host must provide them)
//   stub:     string[]  — deps ALIASED to an empty module and bundled in, for
//                         transitive deps that are pulled in but never reached at
//                         runtime. Prefer `stub` over `external` when possible so
//                         the bundle stays SELF-CONTAINED (installable on a light
//                         core that doesn't ship the dep). security_scan stubs
//                         `ssh2`: dockerode → docker-modem requires it only for
//                         ssh:// connections; the scanner talks to the unix docker
//                         socket, so ssh2 is never invoked. The empty stub makes
//                         `require('ssh2')` return {} and `.Client` undefined —
//                         safe because it is never called.
const EMPTY_STUB = fileURLToPath(new URL('stubs/empty.cjs', import.meta.url));

function readModuleBfmod(moduleDir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8'));
        const bf = (pkg && pkg.bfmod) || {};
        const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);
        return { external: list(bf.external), stub: list(bf.stub) };
    } catch (_) {
        return { external: [], stub: [] };
    }
}

async function buildServer(moduleDir) {
    const entry = path.join(moduleDir, 'server', 'src', 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`missing ${entry}`);
    const outfile = path.join(moduleDir, 'server', 'entry.cjs');
    const { external, stub } = readModuleBfmod(moduleDir);
    if (external.length) console.log('external ->', external.join(', '));
    if (stub.length) console.log('stub     ->', stub.join(', '));
    const alias = {};
    for (const name of stub) alias[name] = EMPTY_STUB;
    await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',       // node: builtins are auto-external
        format: 'cjs',
        target: 'node22',
        minify: false,
        sourcemap: false,
        // Bundle everything the module imports; only node core + declared
        // externals stay external. Stubbed deps are aliased to an empty module
        // and bundled in. (platform:'node' already externalises node builtins.)
        external,
        alias,
        legalComments: 'none',
    });
    return outfile;
}

function buildFrontend(moduleDir) {
    const feDir = path.join(moduleDir, 'frontend');
    if (!fs.existsSync(path.join(feDir, 'src'))) {
        console.log('No frontend/src — skipping frontend build.');
        return null;
    }
    if (!fs.existsSync(path.join(feDir, 'vite.config.js'))) {
        throw new Error('frontend/vite.config.js missing (lib mode + react externals required)');
    }
    // Shell out to vite (not an SDK dep). npx resolves it from the module's
    // own devDependencies or an enclosing workspace.
    const res = spawnSync('npx', ['vite', 'build'], {
        cwd: feDir,
        stdio: 'inherit',
        env: process.env,
    });
    if (res.status !== 0) {
        throw new Error(`vite build failed (exit ${res.status}). Is vite installed in ${feDir}?`);
    }
    return path.join(feDir, 'index.js');
}

function copyManifest(moduleDir) {
    const src = path.join(moduleDir, 'module.manifest.json');
    const dst = path.join(moduleDir, 'manifest.json');
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        return dst;
    }
    if (!fs.existsSync(dst)) {
        throw new Error('neither module.manifest.json nor manifest.json found');
    }
    return dst;
}

async function main() {
    const args = process.argv.slice(2);
    const skipFe = args.includes('--skip-frontend');
    const moduleDir = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());

    const manifest = copyManifest(moduleDir);
    console.log('manifest ->', path.relative(moduleDir, manifest));

    const server = await buildServer(moduleDir);
    console.log('server   ->', path.relative(moduleDir, server));

    if (!skipFe) {
        const fe = buildFrontend(moduleDir);
        if (fe) console.log('frontend ->', path.relative(moduleDir, fe));
    }

    console.log('\nBuilt. Next:  node scripts/pack.mjs', JSON.stringify(moduleDir));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => { console.error('build failed:', e.message); process.exit(1); });
}

export { buildServer, buildFrontend, copyManifest };
