// @typecheck strict
'use strict';
/**
 * Opening a zip package somebody uploaded or mailed in, without first paying
 * for what it would inflate to.
 *
 * A zip declares its entry count (the end-of-central-directory record) and,
 * per entry, the compressed and uncompressed sizes. Those declarations are
 * read BEFORE JSZip builds an entry for every member, and refused when they
 * pass a cap; then every part is inflated as a stream, counting bytes as they
 * come in, and cut off at the first chunk that passes the part's declared
 * size, the caller's cap for that part, or the running budget of the whole
 * package. The declarations are never trusted: a part that lies about its
 * size costs one chunk, not the inflated size.
 *
 * The workbook guard (automationRunner/tables/workbookZipGuard.js) builds on
 * the same primitives with its own messages; this module is for the other
 * packages: an order archive, a .docx whose styles are read, a CMS site
 * export, a presentation.
 */

const JSZip = require('jszip');

const MIB = 1024 * 1024;
const DEFAULT_MAX_RATIO = 200;
const DEFAULT_RATIO_FLOOR_BYTES = 10 * MIB;

class ZipLimitError extends Error {
    /** @param {string} message @param {string} reason */
    constructor(message, reason) { super(message); this.name = 'ZipLimitError'; this.code = 'zip_rejected'; this.reason = reason; }
}

/**
 * The entry count the end-of-central-directory record declares, read without
 * opening the package; null when no record is found (JSZip then refuses the
 * file by itself).
 * @param {Buffer} buffer
 */
function declaredEntryCount(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
    const lowest = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= lowest; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) return buffer.readUInt16LE(i + 10);
    }
    return null;
}

/**
 * @typedef {import('jszip').JSZipObject & { _data?: { uncompressedSize?: number, compressedSize?: number } | null }} ZipEntry
 */

/**
 * The sizes an entry declares (0 when unknown).
 * @param {ZipEntry} entry
 * @returns {{ uncompressed: number, compressed: number }}
 */
function declaredSizes(entry) {
    const d = entry && entry._data;
    return {
        uncompressed: d && Number.isFinite(d.uncompressedSize) ? /** @type {number} */ (d.uncompressedSize) : 0,
        compressed: d && Number.isFinite(d.compressedSize) ? /** @type {number} */ (d.compressedSize) : 0,
    };
}

/**
 * Inflate one part as a stream, never in full. `onChunk` sees every chunk the
 * moment it exists and may throw to stop the part: the stream is paused at
 * once, so a part that lies about its size is cut off after one chunk.
 * @param {ZipEntry} entry
 * @param {(chunk: Uint8Array) => void} onChunk
 * @param {{ unreadable: () => Error, broken: () => Error }} errors  what to reject with when the part
 *   cannot be streamed at all, and when the inflater fails midway
 * @returns {Promise<void>}
 */
function inflateStreaming(entry, onChunk, errors) {
    return new Promise((resolve, reject) => {
        let settled = false;
        /** @type {import('jszip').JSZipStreamHelper<Uint8Array> | undefined} */
        let helper;
        /** @param {Error} err */
        const fail = (err) => {
            if (settled) return;
            settled = true;
            if (helper) helper.pause();
            reject(err);
        };
        try {
            helper = /** @type {{ internalStream: (type: 'uint8array') => import('jszip').JSZipStreamHelper<Uint8Array> }} */ (/** @type {unknown} */ (entry)).internalStream('uint8array');
        } catch {
            fail(errors.unreadable());
            return;
        }
        if (!helper) return; // unreachable: the catch above returned
        helper
            .on('data', (chunk) => {
                if (settled) return;
                try { onChunk(chunk); } catch (err) { fail(/** @type {Error} */ (err)); }
            })
            .on('error', () => fail(errors.broken()))
            .on('end', () => {
                if (settled) return;
                settled = true;
                resolve();
            })
            .resume();
    });
}

/**
 * A running budget over several parts: `take(n)` throws once the total passes
 * the cap (0 = unlimited).
 * @param {number} maxBytes
 * @param {() => Error} [exceeded]
 */
function createByteBudget(maxBytes, exceeded) {
    let used = 0;
    return {
        get used() { return used; },
        get remaining() { return maxBytes > 0 ? Math.max(0, maxBytes - used) : Infinity; },
        /** @param {number} n */
        take(n) {
            used += n;
            if (maxBytes > 0 && used > maxBytes) {
                throw exceeded ? exceeded() : new ZipLimitError(`The package unpacks to more than ${Math.round(maxBytes / MIB)} MB.`, 'total_too_large');
            }
        },
    };
}

const DEFAULT_ERRORS = {
    unreadable: () => new ZipLimitError('The package has a part that cannot be read.', 'unreadable'),
    broken: () => new ZipLimitError('The package has a part that does not unpack to the size it declares.', 'broken'),
};

/**
 * Inflate one part into a Buffer, cut off at `maxBytes`, at the part's own
 * declared size, and at the shared `budget` when one is given. Counts what the
 * inflater really outputs.
 * @param {ZipEntry} entry
 * @param {{ maxBytes?: number, budget?: ReturnType<typeof createByteBudget> | null, errors?: typeof DEFAULT_ERRORS }} [opts]
 * @returns {Promise<Buffer>}
 */
async function readEntryCapped(entry, { maxBytes = 0, budget = null, errors = DEFAULT_ERRORS } = {}) {
    const { uncompressed } = declaredSizes(entry);
    if (maxBytes > 0 && uncompressed > maxBytes) {
        throw new ZipLimitError(`${entry.name} declares ${Math.round(uncompressed / MIB)} MB, more than the ${Math.round(maxBytes / MIB)} MB a part may hold.`, 'part_too_large');
    }
    if (budget && uncompressed > budget.remaining) {
        budget.take(uncompressed); // throws the budget's own error
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let seen = 0;
    await inflateStreaming(entry, (chunk) => {
        seen += chunk.length;
        if (seen > uncompressed) throw errors.broken();
        if (maxBytes > 0 && seen > maxBytes) {
            throw new ZipLimitError(`${entry.name} unpacks to more than the ${Math.round(maxBytes / MIB)} MB a part may hold.`, 'part_too_large');
        }
        if (budget) budget.take(chunk.length);
        chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
    }, errors);
    return Buffer.concat(chunks);
}

/**
 * Open a package and refuse, on its declarations alone, one that holds more
 * entries or would unpack to more bytes than allowed, or that holds a part
 * compressed far beyond what real content reaches. Nothing is inflated here.
 * @param {Buffer} buffer
 * @param {{ maxEntries: number, maxTotalBytes: number, maxRatio?: number, ratioFloorBytes?: number }} limits  0 = unlimited
 * @returns {Promise<{ zip: JSZip, entries: ZipEntry[], dirs: ZipEntry[], declaredTotal: number }>}
 */
async function openZipGuarded(buffer, { maxEntries, maxTotalBytes, maxRatio = DEFAULT_MAX_RATIO, ratioFloorBytes = DEFAULT_RATIO_FLOOR_BYTES }) {
    const tooMany = () => new ZipLimitError(`The package holds more than ${maxEntries.toLocaleString('en-US')} entries.`, 'too_many_entries');
    const declared = declaredEntryCount(buffer);
    if (maxEntries > 0 && declared !== null && declared > maxEntries) throw tooMany();
    /** @type {JSZip} */
    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch {
        throw new ZipLimitError('The file is not a readable zip package.', 'not_a_zip');
    }
    const all = /** @type {ZipEntry[]} */ (Object.values(zip.files));
    const entries = all.filter((e) => !e.dir);
    if (maxEntries > 0 && entries.length > maxEntries) throw tooMany();
    const declaredTotal = checkDeclaredSizes(entries, { maxTotalBytes, maxRatio, ratioFloorBytes });
    return { zip, entries, dirs: all.filter((e) => e.dir), declaredTotal };
}

/**
 * The declared total of the parts, refused past the cap or on a ratio no real
 * content reaches (only for parts past the floor: small parts compress wildly).
 * @param {ZipEntry[]} entries
 * @param {{ maxTotalBytes: number, maxRatio: number, ratioFloorBytes: number }} limits
 */
function checkDeclaredSizes(entries, { maxTotalBytes, maxRatio, ratioFloorBytes }) {
    let declaredTotal = 0;
    for (const entry of entries) {
        const { uncompressed, compressed } = declaredSizes(entry);
        declaredTotal += uncompressed;
        if (maxTotalBytes > 0 && declaredTotal > maxTotalBytes) {
            throw new ZipLimitError(`The package would unpack to more than ${Math.round(maxTotalBytes / MIB)} MB.`, 'total_too_large');
        }
        if (maxRatio > 0 && uncompressed > ratioFloorBytes && compressed > 0 && uncompressed / compressed > maxRatio) {
            throw new ZipLimitError('The package holds a part compressed far beyond what real content reaches.', 'ratio');
        }
    }
    return declaredTotal;
}

/**
 * The caps for an office package (a .docx) that a parser such as mammoth will
 * open in full on the event loop. Environment variables, read on every call,
 * 0 = unlimited:
 *   OFFICE_PACKAGE_MAX_ENTRIES          10000
 *   OFFICE_PACKAGE_MAX_INFLATED_BYTES   256 MiB  all parts together
 *   OFFICE_PACKAGE_MAX_PART_BYTES       64 MiB   one part
 * @param {Record<string, string | undefined>} [env]
 */
function officePackageLimits(env = process.env) {
    /** @param {string} name @param {number} fallback */
    const cap = (name, fallback) => {
        const raw = env[name];
        if (raw == null || raw === '') return fallback;
        const n = Number(raw);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
    };
    return {
        maxEntries: cap('OFFICE_PACKAGE_MAX_ENTRIES', 10_000),
        maxTotalBytes: cap('OFFICE_PACKAGE_MAX_INFLATED_BYTES', 256 * MIB),
        maxPartBytes: cap('OFFICE_PACKAGE_MAX_PART_BYTES', 64 * MIB),
    };
}

/**
 * Check a whole package before a parser that inflates it in full sees it:
 * the declarations first (openZipGuarded), then every part inflated as a
 * stream and discarded, counted against its declared size, the part cap and
 * the running total. Throws ZipLimitError; resolves when the package is within
 * the caps.
 * @param {Buffer} buffer
 * @param {{ maxEntries: number, maxTotalBytes: number, maxPartBytes?: number }} limits  0 = unlimited
 * @returns {Promise<void>}
 */
async function scanPackage(buffer, { maxEntries, maxTotalBytes, maxPartBytes = 0 }) {
    const { entries } = await openZipGuarded(buffer, { maxEntries, maxTotalBytes });
    const budget = createByteBudget(maxTotalBytes);
    const partTooLarge = () => new ZipLimitError(`A part unpacks to more than the ${Math.round(maxPartBytes / MIB)} MB a part may hold.`, 'part_too_large');
    for (const entry of entries) {
        const { uncompressed } = declaredSizes(entry);
        if (maxPartBytes > 0 && uncompressed > maxPartBytes) throw partTooLarge();
        let seen = 0;
        await inflateStreaming(entry, (chunk) => {
            seen += chunk.length;
            if (seen > uncompressed) throw DEFAULT_ERRORS.broken();
            if (maxPartBytes > 0 && seen > maxPartBytes) throw partTooLarge();
            budget.take(chunk.length);
        }, DEFAULT_ERRORS);
    }
}

module.exports = { ZipLimitError, declaredEntryCount, declaredSizes, inflateStreaming, createByteBudget, readEntryCapped, openZipGuarded, scanPackage, officePackageLimits, MIB };
