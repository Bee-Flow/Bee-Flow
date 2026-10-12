#!/usr/bin/env node
/**
 * Install a Learning Center video pack from a tarball into LEARN_MEDIA_DIR:
 * the OFFLINE route (the server fetches the pinned pack by itself at startup,
 * see server/learning/learnMediaSync.js).
 *
 *   npm run learn-media:fetch                       source from LEARN_MEDIA_PACK_URL
 *   npm run learn-media:fetch -- <url-or-path>      source given explicitly
 *
 *   LEARN_MEDIA_PACK_URL     https URL of a .tar.gz pack, or a local file path
 *   LEARN_MEDIA_PACK_SHA256  optional: sha256 (hex) of the tarball itself
 *   LEARN_MEDIA_DIR          target directory (default server/data/learn-media,
 *                            gitignored) — the directory the server serves at
 *                            GET /learn-media/* (server/learning/learnMedia.js)
 *
 * All the logic (path safety, manifest verification, atomic in-place install
 * with rollback) lives in server/learning/learnMediaInstall.js, shared with
 * the server's own startup sync; this file is the command line around it.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const require = createRequire(import.meta.url);
const install = require('../server/learning/learnMediaInstall.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIR = path.join(ROOT, 'server', 'data', 'learn-media');
export const ALLOWED_EXTS = install.ALLOWED_EXTS;
export const isSafePackPath = install.isSafePackPath;
export const obtainTarball = install.obtainTarball;
export const listTarEntries = install.listTarEntries;
export const verifyPack = install.verifyPack;
export const installedPackFiles = install.installedPackFiles;
export const fetchLearnMediaPack = (opts) => install.fetchLearnMediaPack({ dest: DEFAULT_DIR, ...opts });

// Run as a command, not imported by a test (see entry-point.mjs).
if (isEntryPoint(import.meta.url)) {
    const source = process.argv[2] || process.env.LEARN_MEDIA_PACK_URL || '';
    const dest = process.env.LEARN_MEDIA_DIR ? path.resolve(process.env.LEARN_MEDIA_DIR) : DEFAULT_DIR;
    try {
        await fetchLearnMediaPack({ source, dest, expectedSha256: process.env.LEARN_MEDIA_PACK_SHA256 || '', log: (m) => console.log(`learn-media:fetch: ${m}`) });
    } catch (err) {
        console.error(`learn-media:fetch failed: ${err.message}`);
        process.exit(1);
    }
}
