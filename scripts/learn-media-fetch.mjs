#!/usr/bin/env node
/**
 * Install a Learning Center video pack into LEARN_MEDIA_DIR.
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
 * Lesson videos never go in git or in the image; this is how a deployment
 * gets them. Without a pack the lesson player simply drops its video steps.
 *
 * WHAT IS CHECKED, before anything replaces the current pack
 *   • the tarball holds only directories and regular files (no links, no
 *     devices), no absolute paths, no `..`, no dot files, and only
 *     .mp4 / .vtt / .jpg / .webp / .json;
 *   • its manifest.json (at the root, or inside one top-level directory)
 *     carries `files: { "<relative path>": "<sha256 hex>" }` covering EVERY
 *     file in the pack, and every hash matches;
 *   • every file a video entry names (file, captions.en, poster) is in that list.
 *
 * HOW IT IS INSTALLED
 *   LEARN_MEDIA_DIR itself is never renamed or replaced: it is typically a
 *   Docker volume or a bind mount, and a mount point cannot be renamed, while a
 *   bind-mounted host directory that is swapped out stays mounted in the
 *   container as the old (deleted) directory. So the pack is unpacked into a
 *   dot directory INSIDE LEARN_MEDIA_DIR (same filesystem, never served: the
 *   server refuses dot files), verified there, and then moved in file by file
 *   with rename (atomic per file), manifest.json LAST: until that last rename
 *   the old manifest is the live one, and after it the new manifest only names
 *   files that are already in place. Only then are the files the OLD manifest
 *   listed and the new one does not removed. Nothing a manifest never listed is
 *   ever deleted, so a mistyped LEARN_MEDIA_DIR cannot wipe a directory.
 *   A failed run leaves the old pack live and removes what it had moved in.
 *
 * Extraction uses the system `tar` (GNU tar, bsdtar on macOS, tar.exe on
 * Windows 10+); there is no npm dependency for it.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIR = path.join(ROOT, 'server', 'data', 'learn-media');
export const ALLOWED_EXTS = Object.freeze(['.mp4', '.vtt', '.jpg', '.webp', '.json']);
const MAX_PACK_BYTES = 4 * 1024 ** 3;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Is `rel` (forward slashes) a path a pack may contain? Directories end in '/'. */
export function isSafePackPath(rel) {
    if (typeof rel !== 'string' || !rel || rel.length > 256) return false;
    const trimmed = rel.replace(/^\.\//, '');
    if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) || trimmed.includes('\\')) return false;
    const isDir = trimmed.endsWith('/');
    const parts = (isDir ? trimmed.slice(0, -1) : trimmed).split('/');
    if (!parts.every((p) => SEGMENT.test(p) && !p.includes('..'))) return false;
    return isDir || ALLOWED_EXTS.includes(path.extname(trimmed).toLowerCase());
}

async function sha256File(file) {
    const hash = createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
}

/** Copy or download the source to `file`. Only https (or http on loopback, for tests). */
export async function obtainTarball(source, file, { fetchImpl = globalThis.fetch } = {}) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a constant anchored prefix test, no repeat: linear
    if (/^https?:\/\//i.test(source)) {
        const url = new URL(source);
        const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
        if (url.protocol !== 'https:' && !loopback) throw new Error('LEARN_MEDIA_PACK_URL must be an https URL');
        const res = await fetchImpl(url, { redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > MAX_PACK_BYTES) throw new Error(`pack too large (${declared} bytes)`);
        let seen = 0;
        const body = Readable.fromWeb(res.body);
        body.on('data', (chunk) => {
            seen += chunk.length;
            if (seen > MAX_PACK_BYTES) body.destroy(new Error('pack too large'));
        });
        await pipeline(body, fs.createWriteStream(file));
        return;
    }
    const local = path.resolve(source);
    if (!fs.statSync(local).isFile()) throw new Error(`${local} is not a file`);
    fs.copyFileSync(local, file);
}

/** Entry list of a .tar.gz, refusing links, special files and unsafe names. */
export function listTarEntries(tarball, { tar = 'tar' } = {}) {
    const verbose = execFileSync(tar, ['-tvzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const names = execFileSync(tar, ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').filter(Boolean);
    const kinds = verbose.split('\n').filter(Boolean).map((line) => line[0]);
    if (kinds.length !== names.length) throw new Error('could not read the tarball listing');
    names.forEach((name, i) => {
        if (kinds[i] !== '-' && kinds[i] !== 'd') throw new Error(`pack entry ${name} is not a regular file or directory`);
        if (name === './' || name === '.') return;
        if (!isSafePackPath(kinds[i] === 'd' && !name.endsWith('/') ? `${name}/` : name)) throw new Error(`pack entry ${JSON.stringify(name)} is not allowed`);
    });
    return names;
}

/** Every regular file under `dir`, as forward-slash relative paths; anything else throws. */
function walkFiles(dir, prefix = '') {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        const full = path.join(dir, ent.name);
        const st = fs.lstatSync(full);
        if (st.isDirectory()) out.push(...walkFiles(full, rel));
        else if (st.isFile()) out.push(rel);
        else throw new Error(`${rel} is not a regular file`);
    }
    return out;
}

/**
 * Verify an extracted pack directory against its manifest. Returns the parsed
 * manifest; throws with a precise reason otherwise.
 */
export async function verifyPack(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('pack has no manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { throw new Error(`manifest.json is not JSON: ${e.message}`); }
    if (!manifest || typeof manifest !== 'object' || !manifest.videos || typeof manifest.videos !== 'object' || Array.isArray(manifest.videos)) {
        throw new Error('manifest.json has no videos object');
    }
    const listed = manifest.files;
    if (!listed || typeof listed !== 'object' || Array.isArray(listed)) throw new Error('manifest.json has no files { path: sha256 } map');

    const present = walkFiles(dir).filter((f) => f !== 'manifest.json');
    for (const f of present) {
        if (!isSafePackPath(f)) throw new Error(`pack file ${f} is not allowed`);
        if (!Object.prototype.hasOwnProperty.call(listed, f)) throw new Error(`pack file ${f} is not listed in manifest.files`);
    }
    for (const [rel, expected] of Object.entries(listed)) {
        if (!isSafePackPath(rel) || rel === 'manifest.json') throw new Error(`manifest.files lists an invalid path ${JSON.stringify(rel)}`);
        if (typeof expected !== 'string' || !HEX64.test(expected.toLowerCase())) throw new Error(`manifest.files[${rel}] is not a sha256 hex digest`);
        const full = path.join(dir, ...rel.split('/'));
        if (!fs.existsSync(full)) throw new Error(`manifest.files lists ${rel}, which is not in the pack`);
        const actual = await sha256File(full);
        if (actual !== expected.toLowerCase()) throw new Error(`sha256 mismatch for ${rel}`);
    }
    for (const [id, v] of Object.entries(manifest.videos)) {
        if (!v || typeof v !== 'object') throw new Error(`video ${id} is not an object`);
        const refs = [v.file, v.captions?.en, v.poster].filter((r) => r !== undefined);
        if (typeof v.file !== 'string') throw new Error(`video ${id} has no file`);
        for (const r of refs) {
            if (typeof r !== 'string' || !Object.prototype.hasOwnProperty.call(listed, r)) throw new Error(`video ${id} names ${JSON.stringify(r)}, which manifest.files does not cover`);
        }
    }
    return manifest;
}

/** The pack root inside an extraction directory: itself, or its single top-level directory. */
function packRoot(dir) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory() && fs.existsSync(path.join(dir, entries[0].name, 'manifest.json'))) {
        return path.join(dir, entries[0].name);
    }
    throw new Error('pack has no manifest.json at its root');
}

// Temporary entries live inside the target directory, under a dot name: the
// same filesystem (so rename works), never served, never a valid pack path.
const TEMP_PREFIX = '.learn-media-';

const abs = (dir, rel) => path.join(dir, ...rel.split('/'));

/** The files the installed pack's manifest lists (its `files` keys), or [] when there is none. */
export function installedPackFiles(target) {
    try {
        const files = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'))?.files;
        if (!files || typeof files !== 'object' || Array.isArray(files)) return [];
        return Object.keys(files).filter((rel) => rel !== 'manifest.json' && isSafePackPath(rel) && !rel.endsWith('/'));
    } catch {
        return [];
    }
}

/** Remove a pack file and every directory above it (up to `target`) that is left empty. */
function removePackFile(target, rel) {
    fs.rmSync(abs(target, rel), { force: true });
    let dir = path.dirname(abs(target, rel));
    while (dir !== target && dir.startsWith(target + path.sep)) {
        try { fs.rmdirSync(dir); } catch { break; } // not empty (or gone): stop
        dir = path.dirname(dir);
    }
}

/**
 * Move a verified pack from `root` into `target`, manifest.json last, then drop
 * the files only the previous manifest named. See HOW IT IS INSTALLED above.
 */
function installInPlace(root, target, manifest, previous) {
    const incoming = Object.keys(manifest.files).sort();
    const moved = [];
    try {
        for (const rel of incoming) {
            fs.mkdirSync(path.dirname(abs(target, rel)), { recursive: true });
            fs.renameSync(abs(root, rel), abs(target, rel));
            moved.push(rel);
        }
        fs.renameSync(path.join(root, 'manifest.json'), path.join(target, 'manifest.json'));
    } catch (e) {
        // The old manifest is still the live one: take back what it does not name.
        const keep = new Set(previous);
        for (const rel of moved) if (!keep.has(rel)) removePackFile(target, rel);
        throw e;
    }
    const now = new Set(incoming);
    let removed = 0;
    for (const rel of previous) {
        if (now.has(rel)) continue;
        removePackFile(target, rel);
        removed += 1;
    }
    return removed;
}

/**
 * Download/copy, verify and install a pack. On any failure the current pack in
 * `dest` stays live and every temporary file is removed.
 */
export async function fetchLearnMediaPack({ source, dest = DEFAULT_DIR, expectedSha256 = '', fetchImpl, tar = 'tar', log = () => {} }) {
    if (!source) throw new Error('no pack source: set LEARN_MEDIA_PACK_URL or pass a URL or path');
    const target = path.resolve(dest);
    fs.mkdirSync(target, { recursive: true });
    if (!fs.statSync(target).isDirectory()) throw new Error(`${target} is not a directory`);
    const tag = `${process.pid}-${Date.now()}`;
    const tarball = path.join(target, `${TEMP_PREFIX}download-${tag}.tar.gz`);
    const staging = path.join(target, `${TEMP_PREFIX}staging-${tag}`);
    try {
        log(`fetching ${/^https?:/i.test(source) ? new URL(source).origin + '/…' : source}`);
        await obtainTarball(source, tarball, { fetchImpl });
        const digest = await sha256File(tarball);
        if (expectedSha256 && digest !== expectedSha256.trim().toLowerCase()) throw new Error('tarball sha256 does not match LEARN_MEDIA_PACK_SHA256');
        listTarEntries(tarball, { tar });
        fs.mkdirSync(staging);
        execFileSync(tar, ['-xzf', tarball, '-C', staging, '--no-same-owner'], { stdio: 'pipe' });
        const root = packRoot(staging);
        const manifest = await verifyPack(root);
        const removed = installInPlace(root, target, manifest, installedPackFiles(target));
        const videos = Object.keys(manifest.videos).length;
        log(`installed pack ${manifest.version ?? '(no version)'}: ${videos} video(s) in ${target}${removed ? `, ${removed} old file(s) removed` : ''}`);
        return { dir: target, version: manifest.version, videos, sha256: digest };
    } finally {
        for (const p of [tarball, staging]) fs.rmSync(p, { recursive: true, force: true });
    }
}

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
