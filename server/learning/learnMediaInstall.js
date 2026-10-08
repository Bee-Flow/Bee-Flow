'use strict';
/**
 * Install a Learning Center video pack into LEARN_MEDIA_DIR.
 *
 * Two routes lead here, one safety model:
 *   • fetchLearnMediaPack(): a `.tar.gz` pack (URL or local path), the offline
 *     route behind `npm run learn-media:fetch` (scripts/learn-media-fetch.mjs
 *     is a thin wrapper around this module);
 *   • syncFromPin(): what the server does by itself at startup. A pin
 *     (learnMediaPack.json, written per release) names a manifest, its sha256
 *     and the release it lives in; the manifest lists every file with its own
 *     sha256, and only the files not already on disk are downloaded.
 *
 * WHAT IS CHECKED, before anything replaces the current pack
 *   • only directories and regular files (no links, no devices), no absolute
 *     paths, no `..`, no dot files, and only .mp4 / .vtt / .jpg / .webp / .json;
 *   • a manifest.json carrying `files: { "<relative path>": "<sha256 hex>" }`
 *     covering EVERY file in the pack, every hash matching;
 *   • every file a video entry names (file, captions.en, poster) is in that list;
 *   • downloads: https only (plain http only on loopback, for tests), every
 *     redirect hop held to the same rule, and a size cap.
 *
 * HOW IT IS INSTALLED
 *   LEARN_MEDIA_DIR itself is never renamed or replaced: it is typically a
 *   Docker volume or a bind mount, and a mount point cannot be renamed, while a
 *   bind-mounted host directory that is swapped out stays mounted in the
 *   container as the old (deleted) directory. So the new files are staged in a
 *   dot directory INSIDE LEARN_MEDIA_DIR (same filesystem, never served: the
 *   server refuses dot files), verified there, and then moved in file by file
 *   with rename (atomic per file), manifest.json LAST: until that last rename
 *   the old manifest is the live one, and after it the new manifest only names
 *   files that are already in place. Only then are the files the OLD manifest
 *   listed and the new one does not removed. Nothing a manifest never listed is
 *   ever deleted, so a mistyped LEARN_MEDIA_DIR cannot wipe a directory.
 *   A failed run leaves the old pack live and removes what it had moved in.
 *
 * Tarballs are extracted with the system `tar`. Callers pass a `log` function.
 */

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const { openUrl, streamToFile } = require('./learnMediaDownload');
const { validatePin, resolveBase } = require('./learnMediaPin');

const ALLOWED_EXTS = Object.freeze(['.mp4', '.vtt', '.jpg', '.webp', '.json']);
const MAX_PACK_BYTES = 4 * 1024 ** 3;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_MANIFEST_BYTES = 5 * 1024 ** 2;
const STALE_TEMP_MS = 2 * 60 * 60 * 1000;
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The default pack directory (what the server serves); loaded lazily so scripts need not resolve express. */
function defaultDir() {
    return require('./learnMedia').learnMediaDir();
}

/** Is `rel` (forward slashes) a path a pack may contain? Directories end in '/'. */
function isSafePackPath(rel) {
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
async function obtainTarball(source, file, { fetchImpl } = {}) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a constant anchored prefix test, no repeat: linear
    if (/^https?:\/\//i.test(source)) {
        const res = await openUrl(source, { fetchImpl, what: 'LEARN_MEDIA_PACK_URL' });
        await streamToFile(res, file, MAX_PACK_BYTES, 'pack too large');
        return;
    }
    const local = path.resolve(source);
    if (!fs.statSync(local).isFile()) throw new Error(`${local} is not a file`);
    fs.copyFileSync(local, file);
}

/** Entry list of a .tar.gz, refusing links, special files and unsafe names. */
function listTarEntries(tarball, { tar = 'tar' } = {}) {
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

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** The `videos` and `files` objects of a parsed manifest; throws when they are not there. */
function manifestMaps(manifest) {
    if (!manifest || typeof manifest !== 'object' || !manifest.videos || typeof manifest.videos !== 'object' || Array.isArray(manifest.videos)) {
        throw new Error('manifest.json has no videos object');
    }
    const listed = manifest.files;
    if (!listed || typeof listed !== 'object' || Array.isArray(listed)) throw new Error('manifest.json has no files { path: sha256 } map');
    return listed;
}

/** One `files` entry: a safe path and a sha256 hex digest. */
function checkListedEntry(rel, expected) {
    if (!isSafePackPath(rel) || rel === 'manifest.json' || rel.endsWith('/')) throw new Error(`manifest.files lists an invalid path ${JSON.stringify(rel)}`);
    if (typeof expected !== 'string' || !HEX64.test(expected.toLowerCase())) throw new Error(`manifest.files[${rel}] is not a sha256 hex digest`);
}

/** Every file a video entry names must be covered by `files`. */
function checkVideoRefs(videos, listed) {
    for (const [id, v] of Object.entries(videos)) {
        if (!v || typeof v !== 'object') throw new Error(`video ${id} is not an object`);
        const refs = [v.file, v.captions?.en, v.poster].filter((r) => r !== undefined);
        if (typeof v.file !== 'string') throw new Error(`video ${id} has no file`);
        for (const r of refs) {
            if (typeof r !== 'string' || !has(listed, r)) throw new Error(`video ${id} names ${JSON.stringify(r)}, which manifest.files does not cover`);
        }
    }
}

/**
 * Verify an extracted pack directory against its manifest. Returns the parsed
 * manifest; throws with a precise reason otherwise.
 */
async function verifyPack(dir) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('pack has no manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { throw new Error(`manifest.json is not JSON: ${e.message}`); }
    const listed = manifestMaps(manifest);

    const present = walkFiles(dir).filter((f) => f !== 'manifest.json');
    for (const f of present) {
        if (!isSafePackPath(f)) throw new Error(`pack file ${f} is not allowed`);
        if (!has(listed, f)) throw new Error(`pack file ${f} is not listed in manifest.files`);
    }
    for (const [rel, expected] of Object.entries(listed)) {
        checkListedEntry(rel, expected);
        const full = path.join(dir, ...rel.split('/'));
        if (!fs.existsSync(full)) throw new Error(`manifest.files lists ${rel}, which is not in the pack`);
        const actual = await sha256File(full);
        if (actual !== expected.toLowerCase()) throw new Error(`sha256 mismatch for ${rel}`);
    }
    checkVideoRefs(manifest.videos, listed);
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
function installedPackFiles(target) {
    try {
        const files = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'))?.files;
        if (!files || typeof files !== 'object' || Array.isArray(files)) return [];
        return Object.keys(files).filter((rel) => rel !== 'manifest.json' && isSafePackPath(rel) && !rel.endsWith('/'));
    } catch {
        return [];
    }
}

/** The version of the installed manifest, or '' when there is none. */
function installedVersion(target) {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'))?.version;
        return typeof v === 'string' ? v : '';
    } catch { return ''; }
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
 * the files only the previous manifest named. Files in `alreadyInPlace` are
 * verified copies that are already at their final path: they are not moved.
 * See HOW IT IS INSTALLED above.
 */
function installInPlace(root, target, manifest, previous, alreadyInPlace = new Set()) {
    const incoming = Object.keys(manifest.files).sort();
    const moved = [];
    try {
        for (const rel of incoming) {
            if (alreadyInPlace.has(rel)) continue;
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

function ensureDir(dest) {
    const target = path.resolve(dest);
    fs.mkdirSync(target, { recursive: true });
    if (!fs.statSync(target).isDirectory()) throw new Error(`${target} is not a directory`);
    return target;
}

/**
 * Download/copy, verify and install a pack. On any failure the current pack in
 * `dest` stays live and every temporary file is removed.
 */
async function fetchLearnMediaPack({ source, dest = defaultDir(), expectedSha256 = '', fetchImpl, tar = 'tar', log = () => {} }) {
    if (!source) throw new Error('no pack source: set LEARN_MEDIA_PACK_URL or pass a URL or path');
    const target = ensureDir(dest);
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

// ── Pin-based sync ──────────────────────────────────────────────────────────

/** Remove temp entries a crashed run left behind (never the lock file). */
function cleanStaleTemp(target, maxAgeMs = STALE_TEMP_MS, now = Date.now()) {
    let names = [];
    try { names = fs.readdirSync(target); } catch { return; }
    for (const name of names) {
        if (!name.startsWith(TEMP_PREFIX) || name.endsWith('.lock')) continue;
        const full = path.join(target, name);
        try {
            if (now - fs.lstatSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { recursive: true, force: true });
        } catch { /* gone already */ }
    }
}

/** sha256 of an existing regular file, or '' when it is missing or not a plain file. */
async function existingSha(file) {
    try {
        if (!fs.lstatSync(file).isFile()) return '';
        return await sha256File(file);
    } catch {
        return '';
    }
}

/**
 * Bring `dir` to the pack the pin names. No-op when that version is installed.
 * Downloads the pinned manifest (sha256-checked), then only the files whose
 * hash is not already on disk; the old pack stays live until every file has
 * been verified. Returns { status, version, downloaded, reused, bytes }.
 */
async function syncFromPin(pin, dir, opts = {}) {
    const { fetchImpl, log = () => {}, timeoutMs } = opts;
    validatePin(pin);
    const target = ensureDir(dir);
    if (installedVersion(target) === pin.version) {
        return { status: 'up-to-date', version: pin.version, downloaded: 0, reused: 0, bytes: 0 };
    }
    cleanStaleTemp(target);

    const base = resolveBase(pin, opts);
    const assetUrl = (name) => new URL(name, base).toString();
    const tag = `${process.pid}-${Date.now()}`;
    const staging = path.join(target, `${TEMP_PREFIX}staging-${tag}`);
    try {
        fs.mkdirSync(staging);
        const manifestFile = path.join(staging, 'manifest.json');
        log(`fetching manifest ${pin.manifest}`);
        const mres = await openUrl(assetUrl(pin.manifest), { fetchImpl, what: 'LEARN_MEDIA_SOURCE', timeoutMs });
        const got = await streamToFile(mres, manifestFile, MAX_MANIFEST_BYTES, 'manifest too large');
        if (got.sha256 !== pin.manifestSha256.toLowerCase()) throw new Error('manifest sha256 does not match the pin');
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { throw new Error(`manifest is not JSON: ${e.message}`); }
        const listed = manifestMaps(manifest);
        if (manifest.version !== pin.version) throw new Error(`manifest version ${JSON.stringify(manifest.version)} does not match the pin ${JSON.stringify(pin.version)}`);

        const assets = new Map();
        for (const [rel, expected] of Object.entries(listed)) {
            checkListedEntry(rel, expected);
            const name = rel.split('/').pop();
            if (assets.has(name)) throw new Error(`manifest.files has two files named ${name}`);
            assets.set(name, rel);
        }
        checkVideoRefs(manifest.videos, listed);
        for (const id of pin.videoIds) if (!has(manifest.videos, id)) throw new Error(`manifest has no video ${id}, which the pin requires`);

        let downloaded = 0;
        let reused = 0;
        let bytes = 0;
        const inPlace = new Set();
        for (const [rel, expected] of Object.entries(listed).sort(([a], [b]) => (a < b ? -1 : 1))) {
            const want = expected.toLowerCase();
            if (await existingSha(abs(target, rel)) === want) {
                inPlace.add(rel);
                reused += 1;
                continue;
            }
            const out = abs(staging, rel);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const res = await openUrl(assetUrl(rel.split('/').pop()), { fetchImpl, what: 'LEARN_MEDIA_SOURCE', timeoutMs });
            const r = await streamToFile(res, out, MAX_FILE_BYTES, 'file too large');
            if (r.sha256 !== want) throw new Error(`sha256 mismatch for ${rel}`);
            downloaded += 1;
            bytes += r.bytes;
        }

        const removed = installInPlace(staging, target, manifest, installedPackFiles(target), inPlace);
        log(`installed pack ${pin.version}: ${downloaded} downloaded, ${reused} reused${removed ? `, ${removed} old file(s) removed` : ''}`);
        return { status: 'installed', version: pin.version, downloaded, reused, bytes };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

module.exports = {
    ALLOWED_EXTS,
    isSafePackPath,
    obtainTarball,
    listTarEntries,
    verifyPack,
    installedPackFiles,
    installedVersion,
    fetchLearnMediaPack,
    validatePin,
    syncFromPin,
    sha256File,
};
