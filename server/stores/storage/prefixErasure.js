// @typecheck strict
/**
 * storageStore.deletePrefix: every object under a key prefix (`users/<id>/`
 * when an account is erased), in whichever mode the store runs. Idempotent
 * (an empty prefix is 0), batched in S3 mode. Only a directory-shaped prefix
 * of two or more plain segments is accepted, so a typo can never sweep the
 * bucket or a whole top-level family, and `.`/`..` never reach the disk.
 * Throws when the store is not initialised or an object could not be
 * deleted: an erasure must then be reported incomplete, never logged as done.
 *
 * The store's state (mode, root resolver, client) is handed in by
 * storageStore.js at call time; nothing here reads the environment.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../../telemetry/log');

/** One path segment: the characters a key may carry, nothing that steers a path. */
const SEGMENT_SHAPE = /^[A-Za-z0-9_.-]+$/;

/** `.` or `..` (or any run of dots): a segment that names a directory, not an object. @param {string} seg */
const isDotsOnly = (seg) => seg.length > 0 && seg.split('.').join('') === '';

/**
 * A directory-shaped prefix: two or more plain segments, ending in '/'.
 * Checked segment by segment, so the pattern stays an anchored character class.
 * @param {unknown} prefix
 */
function isDirectoryPrefix(prefix) {
    if (typeof prefix !== 'string' || !prefix.endsWith('/')) return false;
    const segments = prefix.slice(0, -1).split('/');
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored character class without quantifier nesting
    return segments.length >= 2 && segments.every((seg) => SEGMENT_SHAPE.test(seg) && !isDotsOnly(seg));
}

/**
 * @typedef {{
 *   mode: 's3' | 'local' | null,
 *   localPathFor: (key: string) => string,
 *   listKeys: (prefix: string) => Promise<string[]>,
 *   s3: { send: (command: unknown) => Promise<{ Errors?: unknown[] } | void> } | null,
 *   bucket: string,
 * }} StorageDeps
 */

/**
 * @param {string} prefix  e.g. 'users/<id>/' — ends in '/'
 * @param {StorageDeps} deps
 * @returns {Promise<number>} objects removed
 */
async function deletePrefix(prefix, { mode, localPathFor, listKeys, s3, bucket }) {
    if (!isDirectoryPrefix(prefix)) {
        throw new Error('StorageStore: deletePrefix needs a directory-shaped prefix of two or more segments');
    }
    if (mode === 'local') {
        const dir = localPathFor(prefix.slice(0, -1));
        if (!fs.existsSync(dir)) return 0;
        let removed = 0;
        const walk = (/** @type {string} */ d) => {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                if (entry.isDirectory()) walk(path.join(d, entry.name));
                else if (!/\.(meta|tags)$/.test(entry.name)) removed++;
            }
        };
        walk(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        log.info(`[StorageStore:local] Deleted ${removed} object(s) under ${prefix}`);
        return removed;
    }
    if (!s3) throw new Error('StorageStore not initialized');
    const { DeleteObjectsCommand } = require('@aws-sdk/client-s3');
    const keys = await listKeys(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const r = await s3.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }));
        if (r?.Errors?.length) throw new Error(`StorageStore: ${r.Errors.length} object(s) under ${prefix} could not be deleted`);
    }
    log.info(`[StorageStore] Deleted ${keys.length} object(s) under ${prefix}`);
    return keys.length;
}

module.exports = { deletePrefix };
