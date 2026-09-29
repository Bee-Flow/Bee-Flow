// @typecheck
// RustFS object I/O for a webpage: the three text slots plus the snapshotted
// SQLite database, the card thumbnail, and the prefix purge that runs on
// delete. Bytes only — the metadata rows live in the aggregates.

const crypto = require('crypto');
const storageStore = require('../storageStore');
const { SLOTS, CONTENT_TYPES, sha256, keyFor } = require('./shared');
const log = require('../../telemetry/log');

/**
 * Read one slot's contents from RustFS. Returns '' if the object doesn't
 * exist (treated as empty).
 */
async function readSlot(userId, webpageId, slot, versionId = null) {
    if (!storageStore.isAvailable()) return '';
    const key = keyFor(userId, webpageId, slot, versionId);
    try {
        const { stream } = await storageStore.streamFile(key);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
    } catch (err) {
        // NoSuchKey is expected for empty/optional slots.
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return '';
        throw err;
    }
}

/**
 * Read all three slots in parallel.
 */
async function readAllSlots(userId, webpageId, versionId = null) {
    const [html, css, js] = await Promise.all(
        SLOTS.map(s => readSlot(userId, webpageId, s, versionId))
    );
    return { html, css, js };
}

/**
 * Write one slot's contents to RustFS. Empty content deletes the object
 * so an empty `script.js` doesn't sit around as a 0-byte file.
 */
async function writeSlot(userId, webpageId, slot, content) {
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot persist webpage files');
    }
    const key = keyFor(userId, webpageId, slot);
    if (!content) {
        try { await storageStore.deleteFile(key); } catch (_) {}
        return { sha: '', size: 0 };
    }
    const buf = Buffer.from(content, 'utf8');
    await storageStore.uploadFile(key, buf, CONTENT_TYPES[slot]);
    return { sha: sha256(content), size: buf.length };
}

/**
 * Server-side copy a slot from `current/` into `versions/{vid}/`.
 */
async function copySlotToVersion(userId, webpageId, versionId, slot) {
    if (!storageStore.isAvailable()) return;
    const src = keyFor(userId, webpageId, slot);
    const dst = keyFor(userId, webpageId, slot, versionId);
    try {
        await storageStore.copyObject(src, dst);
    } catch (err) {
        // If the source slot is empty (no object), there's nothing to snapshot.
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return;
        throw err;
    }
}

/**
 * Restore a versioned slot back over `current/` via a server-side copy.
 * Used by the version restore route for the `db` slot (text slots use
 * `writeSlot` because they need the content for the response payload).
 * Returns `true` if the source object existed and was copied; `false` if
 * the version had no object for this slot (e.g. a pre-DB snapshot).
 */
async function restoreSlotFromVersion(userId, webpageId, versionId, slot) {
    if (!storageStore.isAvailable()) return false;
    const src = keyFor(userId, webpageId, slot, versionId);
    const dst = keyFor(userId, webpageId, slot);
    try {
        await storageStore.copyObject(src, dst);
        return true;
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
            // No DB in this snapshot — drop the current one too so the restore
            // is a true reset to the snapshot's state.
            try { await storageStore.deleteFile(dst); } catch (_) {}
            return false;
        }
        throw err;
    }
}

// ── Thumbnail helpers ──────────────────────────────────────────────
//
// A small rendered screenshot stored alongside the slot files in RustFS so
// the Webpages list can render a real preview tile instead of a generic
// icon. Owner-prefixed because every webpage lives under its owner's path.

function thumbnailKey(userId, webpageId) {
    return `users/${userId}/webpages/${webpageId}/thumbnail.png`;
}

async function writeThumbnail(userId, webpageId, buffer) {
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot persist thumbnail');
    }
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const key = thumbnailKey(userId, webpageId);
    await storageStore.uploadFile(key, buf, 'image/png');
    return { sha: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

async function readThumbnail(userId, webpageId) {
    if (!storageStore.isAvailable()) return null;
    try {
        const { stream } = await storageStore.streamFile(thumbnailKey(userId, webpageId));
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        return Buffer.concat(chunks);
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

/**
 * Purge every RustFS object under a webpage's prefix. Called on DELETE.
 */
async function purgeWebpageObjects(userId, webpageId) {
    if (!storageStore.isAvailable()) return 0;
    const prefix = `users/${userId}/webpages/${webpageId}/`;
    try {
        const keys = await storageStore.listKeys(prefix);
        for (const k of keys) {
            try { await storageStore.deleteFile(k); } catch (_) {}
        }
        return keys.length;
    } catch (err) {
        log.warn('[WebpageStore] Purge failed:', err.message);
        return 0;
    }
}

/**
 * Zijn de bytes überhaupt te lezen?
 *
 * `readSlot` antwoordt met '' zodra RustFS niet beschikbaar is — óók tijdens een
 * herverbindingsvenster. Voor het TONEN van een pagina is dat de juiste keuze
 * (leeg is leeg), maar voor het METEN van een regelverschil niet: dan wordt een
 * niet-meting stilletjes "er veranderde niets" (±0), of erger, de hele nieuwe
 * tekst als aanwinst geboekt tegen een oude kant die nooit gelezen is.
 * Aanroepers die iets MÉTEN vragen dit eerst.
 */
function slotsAreReadable() {
    return storageStore.isAvailable();
}

module.exports = {
    readSlot,
    slotsAreReadable,
    readAllSlots,
    writeSlot,
    copySlotToVersion,
    restoreSlotFromVersion,
    thumbnailKey,
    writeThumbnail,
    readThumbnail,
    purgeWebpageObjects,
};
