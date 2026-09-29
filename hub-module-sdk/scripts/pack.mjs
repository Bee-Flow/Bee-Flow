#!/usr/bin/env node
/**
 * pack.mjs — turn a BUILT module directory into an unsigned `.bfmod` ZIP.
 *
 * Input dir layout (produced by build.mjs):
 *   manifest.json        (required)
 *   server/entry.cjs     (built CJS server entry)
 *   frontend/index.js    (built ESM frontend entry, optional)
 *   assets/…             (optional)
 *
 * Output: <id>-<version>.bfmod containing every file above PLUS a generated
 * integrity.json = { algo:'sha256', files:{ '<relpath>': '<hex>' } } covering
 * every packaged file except signature.jws and integrity.json itself. The
 * signature is added afterwards by sign.mjs.
 *
 * This integrity logic is pinned to server/modules/packageVerify.js — keep the
 * two in agreement (a round-trip test in the product enforces it).
 *
 * Usage:  node scripts/pack.mjs <moduleDir> [--out <file.bfmod>]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

const EXCLUDE_NAMES = new Set(['integrity.json', 'signature.jws', '.DS_Store']);
const EXCLUDE_DIRS = new Set(['node_modules', '.git']);

function sha256hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Recursively list files under `dir`, returning POSIX relpaths. */
function walk(dir, base = dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
            if (EXCLUDE_DIRS.has(ent.name)) continue;
            walk(path.join(dir, ent.name), base, out);
        } else if (ent.isFile()) {
            if (EXCLUDE_NAMES.has(ent.name)) continue;
            if (ent.name.endsWith('.bfmod')) continue;
            const rel = path.relative(base, path.join(dir, ent.name)).split(path.sep).join('/');
            out.push(rel);
        }
    }
    return out;
}

async function pack(moduleDir, outFile) {
    const manifestPath = path.join(moduleDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`manifest.json not found in ${moduleDir} — run build.mjs first`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.id || !manifest.version) {
        throw new Error('manifest.json missing id/version');
    }

    // Defense-in-depth: emit snake_case aliases for the compat claims next to
    // the authored camelCase, so even a loader that only reads one spelling
    // enforces the gate. (The signed JWS payload, added by sign.mjs, remains
    // the authoritative source.)
    let manifestChanged = false;
    if (manifest.minAppVersion && !manifest.min_app_version) {
        manifest.min_app_version = manifest.minAppVersion;
        manifestChanged = true;
    }
    if (manifest.maxAppVersion && !manifest.max_app_version) {
        manifest.max_app_version = manifest.maxAppVersion;
        manifestChanged = true;
    }
    if (manifest.hostApiVersion != null && manifest.host_api_version == null) {
        manifest.host_api_version = manifest.hostApiVersion;
        manifestChanged = true;
    }
    if (manifestChanged) {
        fs.writeFileSync(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)));
    }

    const rels = walk(moduleDir).sort();
    if (!rels.includes('manifest.json')) throw new Error('manifest.json not walked — unexpected');

    // Compute integrity over every packaged file.
    const integrity = { algo: 'sha256', files: {} };
    const buffers = new Map();
    for (const rel of rels) {
        const data = fs.readFileSync(path.join(moduleDir, rel));
        buffers.set(rel, data);
        integrity.files[rel] = sha256hex(data);
    }
    const integrityBuf = Buffer.from(JSON.stringify(integrity, null, 2));
    // Persist integrity.json into the dir too (so sign.mjs / auditing can see it).
    fs.writeFileSync(path.join(moduleDir, 'integrity.json'), integrityBuf);

    const zip = new JSZip();
    for (const [rel, data] of buffers) zip.file(rel, data);
    zip.file('integrity.json', integrityBuf);

    const out = outFile || path.resolve(process.cwd(), `${manifest.id}-${manifest.version}.bfmod`);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(out, buf);
    return { out, files: rels.length, sha256: sha256hex(buf) };
}

async function main() {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf('--out');
    const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
    const positional = args.filter((a, i) => a !== '--out' && (outIdx < 0 || i !== outIdx + 1));
    const moduleDir = path.resolve(positional[0] || process.cwd());

    const res = await pack(moduleDir, outFile);
    console.log(`Packed ${res.files} files -> ${res.out}`);
    console.log(`  package sha256: ${res.sha256}`);
    console.log('Next: sign it —  node scripts/sign.mjs', res.out, '<private-key.pem>');
}

// Run only when invoked directly (not when imported). pathToFileURL handles
// spaces/special chars in the path (import.meta.url is percent-encoded).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => { console.error('pack failed:', e.message); process.exit(1); });
}

export { pack, walk, sha256hex };
