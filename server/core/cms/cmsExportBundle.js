/**
 * CMS export bundle — the .zip form of a site export.
 *
 * A JSON export is only ever half a website: every image, video and logo is
 * referenced by storage KEY (`cms/…`), so the JSON alone reconstitutes a site
 * with broken media on any install that doesn't share the bucket. The zip
 * carries the bytes:
 *
 *   site.json                     the v2 bundle (exactly what ?format=json returns)
 *   assets/cms/<file>             each referenced object, at its ORIGINAL key path
 *
 * Import writes each object back under the same key and skips keys that
 * already exist. Keys are minted as `cms/<Date.now()>-<rand>-<name>`, so a
 * collision means the same file — which is what lets the whole feature work
 * with ZERO rewriting of asset references inside the content tree.
 *
 * Everything here is deliberately storage- and store-agnostic apart from the
 * two thin helpers at the bottom, so the zip logic is unit-testable without a
 * bucket.
 *
 * SECURITY: an admin uploads an arbitrary archive here. Every limit below is
 * load-bearing — entry count, per-entry size and total inflated size bound a
 * zip bomb, and the path check bounds zip-slip (`../../etc/passwd` as an entry
 * name). We never write to the filesystem from a zip, only to object storage
 * under a `cms/` prefix, but the prefix check is what guarantees that.
 */

const JSZip = require('jszip');
const storageStore = require('../../stores/storageStore');
const { sanitizeSvg } = require('../../utils/svgSanitizer');

const BUNDLE_ENTRY = 'site.json';
const ASSET_PREFIX = 'assets/';
const KEY_PREFIX   = 'cms/';

// Sized for "a marketing site with real imagery". Uploads are already capped
// at 25 MB each by the CMS upload route, so a legitimate bundle hits the
// total cap long before the per-entry one.
const MAX_ENTRIES          = 1000;
const MAX_ENTRY_BYTES      = 64 * 1024 * 1024;    // 64 MB
const MAX_TOTAL_BYTES      = 200 * 1024 * 1024;   // 200 MB inflated
const MAX_BUNDLE_JSON_BYTES = 16 * 1024 * 1024;   // site.json itself

/**
 * Is this a safe `assets/` entry, and what storage key does it map to?
 * Returns null for anything we refuse to touch.
 */
function assetEntryToKey(entryName) {
    if (!entryName.startsWith(ASSET_PREFIX)) return null;
    const key = entryName.slice(ASSET_PREFIX.length);
    // Zip-slip and absolute-path guards. `cms/` is the only prefix the CMS
    // asset route will ever serve, so anything else is either a mistake or
    // an attempt to write outside the CMS namespace.
    if (!key.startsWith(KEY_PREFIX)) return null;
    if (key.includes('..')) return null;
    if (key.includes('\\')) return null;
    if (key.includes('\0')) return null;
    if (/\/\//.test(key)) return null;
    if (key.length > 512) return null;
    return key;
}

/**
 * Build the .zip.
 *
 * @param {object}  bundle  the v2 export object (goes to site.json verbatim)
 * @param {Array}   assets  [{ key, buffer }]
 * @returns {Promise<Buffer>}
 */
async function buildZip(bundle, assets = []) {
    const zip = new JSZip();
    zip.file(BUNDLE_ENTRY, JSON.stringify(bundle, null, 2));
    for (const asset of assets) {
        if (!asset || typeof asset.key !== 'string' || !Buffer.isBuffer(asset.buffer)) continue;
        if (!asset.key.startsWith(KEY_PREFIX)) continue;
        zip.file(`${ASSET_PREFIX}${asset.key}`, asset.buffer);
    }
    // DEFLATE level 6: images are already compressed, so the gain comes from
    // site.json. Level 9 costs noticeably more CPU for ~nothing here.
    return zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });
}

/**
 * Parse a .zip produced by buildZip (or hand-assembled by a user).
 *
 * @returns {Promise<{ bundle: object, assets: Array<{key, buffer}>, skipped: string[] }>}
 *   `skipped` names entries that were ignored (unsafe path, unknown prefix)
 *   so the caller can tell the user instead of silently dropping them.
 */
async function parseZip(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty upload');

    let zip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch (_) {
        throw new Error('Not a valid .zip file');
    }

    const entries = Object.values(zip.files).filter(f => !f.dir);
    if (entries.length > MAX_ENTRIES) {
        throw new Error(`Archive has too many entries (max ${MAX_ENTRIES})`);
    }

    const bundleEntry = zip.file(BUNDLE_ENTRY);
    if (!bundleEntry) {
        throw new Error(`Archive is missing ${BUNDLE_ENTRY} — is this a Bee Flow site export?`);
    }

    const bundleText = await bundleEntry.async('string');
    if (Buffer.byteLength(bundleText, 'utf8') > MAX_BUNDLE_JSON_BYTES) {
        throw new Error(`${BUNDLE_ENTRY} exceeds the size limit`);
    }
    let bundle;
    try {
        bundle = JSON.parse(bundleText);
    } catch (_) {
        throw new Error(`${BUNDLE_ENTRY} is not valid JSON`);
    }

    const assets = [];
    const skipped = [];
    let total = Buffer.byteLength(bundleText, 'utf8');
    for (const entry of entries) {
        if (entry.name === BUNDLE_ENTRY) continue;
        const key = assetEntryToKey(entry.name);
        if (!key) { skipped.push(entry.name); continue; }

        const buf = await entry.async('nodebuffer');
        if (buf.length > MAX_ENTRY_BYTES) {
            throw new Error(`Asset ${key} exceeds the per-file size limit`);
        }
        total += buf.length;
        if (total > MAX_TOTAL_BYTES) {
            throw new Error(`Archive exceeds the total size limit (${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB uncompressed)`);
        }
        assets.push({ key, buffer: buf });
    }

    return { bundle, assets, skipped };
}

// ── Storage edges ────────────────────────────────────────────────────

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

/**
 * Fetch every referenced asset for an export.
 *
 * A missing object is NEVER fatal: a site whose bucket was partly wiped, or
 * one referencing an external URL that merely looks like a key, must still
 * export. Misses come back in `missing` so the caller can report them rather
 * than quietly shipping an incomplete archive.
 */
async function fetchAssets(keys) {
    const assets = [];
    const missing = [];
    let total = 0;
    for (const key of keys) {
        try {
            const { stream, contentType, contentLength } = await storageStore.streamFile(key);
            // Clips (up to 500 MB) are never buffered into a zip: report them
            // so the caller can tell the user instead of exhausting memory.
            if (Number(contentLength) > MAX_ENTRY_BYTES) {
                stream.destroy?.();
                missing.push(`${key} (too large for a zip export, max ${MAX_ENTRY_BYTES / 1024 / 1024} MB per file)`);
                continue;
            }
            const buffer = await streamToBuffer(stream);
            total += buffer.length;
            if (total > MAX_TOTAL_BYTES) {
                missing.push(`${key} (archive size limit reached)`);
                break;
            }
            assets.push({ key, buffer, contentType, bytes: contentLength ?? buffer.length });
        } catch (err) {
            missing.push(`${key} (${err?.name === 'NoSuchKey' ? 'not found in storage' : String(err?.message || err)})`);
        }
    }
    return { assets, missing };
}

/**
 * Write imported assets back to storage under their original keys.
 *
 * Existing keys are left alone — see the header note on why key collision
 * implies same file. Failures are collected, never thrown: a site that
 * imports with three missing images is far more useful than one that refuses
 * to import at all.
 *
 * SVGs are re-sanitized here, exactly as the upload route does, and the
 * `sanitized` tag is set from THAT result — never from anything the archive
 * claimed. An imported zip is untrusted input; the asset endpoint serves a
 * tagged SVG inline, so honouring a bundle-supplied tag would turn "import a
 * site" into stored XSS. An SVG that fails to sanitize is skipped, not
 * stored raw.
 */
/**
 * `overwrite` exists for the seeder, and defaults to false for imports.
 *
 * Asset keys are deliberately stable (`cms/beeflow-hive.svg`, no hash), so
 * skip-if-exists means the seeder can never CHANGE an asset: editing the SVG
 * source in scripts/content/beeflowAssets.js and re-seeding reported
 * "6 already present" and silently kept serving the old bytes. That is a
 * confusing failure — the seed succeeds, the page looks unchanged, and
 * nothing says why.
 *
 * Importing a bundle keeps the old behaviour on purpose: an imported zip is
 * untrusted and may reference keys another site is already using, so it must
 * not clobber them.
 */
async function restoreAssets(assets, { overwrite = false } = {}) {
    let written = 0;
    let reused = 0;
    const failed = [];
    for (const asset of assets) {
        try {
            let exists = false;
            try {
                await storageStore.headFile(asset.key);
                exists = true;
            } catch (_) { /* miss → write it */ }
            if (exists && !overwrite) { reused++; continue; }

            const contentType = asset.contentType || guessContentType(asset.key);
            let body = asset.buffer;
            let metadata = null;
            if (contentType === 'image/svg+xml') {
                const clean = sanitizeSvg(asset.buffer);
                if (!clean) {
                    failed.push(`${asset.key} (invalid or unsafe SVG)`);
                    continue;
                }
                body = clean;
                metadata = { sanitized: '1' };
            }

            await storageStore.uploadFile(asset.key, body, contentType, metadata);
            written++;
        } catch (err) {
            failed.push(`${asset.key} (${String(err?.message || err)})`);
        }
    }
    return { written, reused, failed };
}

const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt',
};
function guessContentType(key) {
    const dot = key.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    return MIME_BY_EXT[key.slice(dot).toLowerCase()] || 'application/octet-stream';
}

module.exports = {
    buildZip, parseZip, fetchAssets, restoreAssets,
    // exported for tests
    assetEntryToKey, guessContentType,
    BUNDLE_ENTRY, ASSET_PREFIX,
    MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES,
};
