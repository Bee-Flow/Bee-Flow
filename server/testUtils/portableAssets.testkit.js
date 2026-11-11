/**
 * Shared set-up for the tests of an app's uploaded files in a copy (appStudio/portableAssets.mts,
 * portableAssetStore.mts and the doors that use them): real picture bytes, entries as a copy
 * writes them, an in-memory asset store, and the compat corpus apps the doors are tried on.
 */

'use strict';

const { createHash } = require('node:crypto');

/** A real 1x1 PNG; `png(n)` is the same picture with n extra bytes after it, so each has its own sha256. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = (n = 0) => Buffer.concat([PNG, Buffer.alloc(n, n % 251)]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The smallest file the asset sniffer takes for a WOFF2 font: the tag and the true length. */
function woff2(size = 64) {
    const b = Buffer.alloc(size);
    b.write('wOF2', 0, 'latin1');
    b.writeUInt32BE(size, 8);
    return b;
}

/** An entry of a copy, as written by portableAssets.writePortableAssets; `extra` overrides any field. */
function entry(id, bytes = png(), extra = {}) {
    return { id, mime: 'image/png', sha256: sha(bytes), size: bytes.length, data: bytes.toString('base64'), ...extra };
}

/** The ids of the asset-refs corpus app: an image, the logo, and a picture in rich markdown. */
const CORPUS_ASSET_IDS = Object.freeze(['0b6f2c1e-4a8d-4e1f-9c3b-1d2e3f4a5b6c', '7c9e6679-7425-40de-944b-e07fc1f90ae7', '9a1b2c3d-0000-4000-8000-00000000abcd']);

/**
 * An app's asset store in memory, with the deps portableAssetStore.mts takes. `rows` seeds it
 * with [{ id, bytes }]; `storeImpl(bytes, mime)` may throw to play a refused upload.
 */
function memoryAssetStore(rows = [], { storeImpl = null } = {}) {
    const files = new Map(rows.map((r) => [r.id, { id: r.id, bytes: r.bytes, mime: 'image/png' }]));
    const stored = [];
    let seq = 0;
    const rowOf = (f) => ({ id: f.id, fieldKey: 'app:asset', mimeType: f.mime, sha256: sha(f.bytes), size: f.bytes.length, scanned: true, quarantined: false, createdAt: null });
    const deps = {
        listAssetRows: async () => [...files.values()].map(rowOf),
        openAsset: async (_app, row) => {
            const f = files.get(row.id);
            if (!f) return null;
            const { Readable } = require('node:stream');
            return { stream: Readable.from([f.bytes]) };
        },
        storeAsset: async (_app, bytes, mime) => {
            if (storeImpl) storeImpl(bytes, mime);
            seq += 1;
            const id = `new-${seq}`;
            files.set(id, { id, bytes, mime });
            stored.push({ id, mime, size: bytes.length });
            return { id, ref: `asset:${id}`, mime, size: bytes.length, createdAt: null, usedBy: { draft: [], published: [] } };
        },
    };
    return { deps, stored, files };
}

/** One app of the compat corpus (read only: the corpus files are frozen inputs). */
function corpusApp(name) {
    const { readCorpus } = require('../appStudio/compat/corpus.mts');
    return JSON.parse(JSON.stringify(readCorpus(name)));
}

/** An entry for every file `definition` refers to (a font for an id that names a font role, a picture otherwise). */
function entriesFor(definition) {
    const { collectAssetRefs } = require('../appStudio/appAssets.mts');
    return [...collectAssetRefs(definition)].map(([id, paths], i) => entry(id, paths.some((p) => p.includes('fonts')) ? woff2(64 + i) : png(i)));
}

module.exports = { PNG, png, woff2, sha, entry, entriesFor, CORPUS_ASSET_IDS, memoryAssetStore, corpusApp };
