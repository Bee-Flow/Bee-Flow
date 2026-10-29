// @typecheck
// Keeps locale overrides attached to the ITEM they translate.
//
// An override stores an array as a sparse, index-aligned list (see
// mergeLocaleContent in shared.js). When the default-language content changes an
// array (reorder, insert, delete), every translation would silently land on a
// different item. So whenever the default content is saved, in the same
// transaction, each stored override is re-aligned to the new order.
//
// Per array, each new item is matched to an old slot by, in order:
//   1. its `id` (header CTAs, nav items, footer columns, ...),
//   2. identical content (a pure reorder of id-less items such as FAQ entries),
//   3. an orphaned translation parked earlier for the same item (undo / move back),
//   4. the same position, when the old item at that slot found no successor
//      (an item edited in place, or re-created with a fresh id).
// An item that matches nothing is new and starts untranslated. The translation
// of an item that disappeared is parked under `_orphans` (bounded) so deleting
// and then undoing does not lose it.
//
// Limit: an item that is edited AND moved in the same save has no id and no equal
// content, so it falls back to its position.
// The stored override format stays what it was, so the editor, the renderer and
// existing overrides need no migration.

const crypto = require('crypto');
const configStore = require('../configStore');
const { revOf, assertRevMatches } = require('./revision');

/** configStore.withConfigGroup is attached at load time (configStoreGroup.js). */
const store = /** @type {typeof configStore & { withConfigGroup: ReturnType<typeof import('../configStoreGroup').createWithConfigGroup> }} */ (configStore);
/**
 * @type {typeof store.withConfigGroup}
 * @param {string} lockKey
 */
const withConfigGroup = (lockKey, work) => store.withConfigGroup(lockKey, work);
const {
    KEY_LOCALE_INFIX, isPlainObject, pageKey, projectKey, projectLocaleKey,
} = require('./shared');

const ORPHAN_CAP = 100;

/** @typedef {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>, keysLike: (pattern: string) => Promise<string[]> }} ConfigIo */

/**
 * isPlainObject as a type guard: a non-null, non-array object.
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => isPlainObject(v);

/** @typedef {{ id?: unknown, content?: unknown }} StoredBlock */

/** @param {{ id: string; }} item */
function itemKey(item) {
    if (isPlainObject(item) && typeof item.id === 'string' && item.id !== '') return `id:${item.id}`;
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_sha1 -- a content fingerprint to pair items, not a security use
    return `j:${crypto.createHash('sha1').update(JSON.stringify(item) ?? 'undefined').digest('hex').slice(0, 16)}`;
}

/**
 * The result is of the same kind as `override`: an array stays an array, an
 * object keeps its keys, anything else is returned as is.
 * @template T
 * @param {unknown} prev  default-language content before the save
 * @param {unknown} next  default-language content after the save
 * @param {T} override  index-aligned to `prev`
 * @param {Record<string, any>} orphans  mutable bag of parked translations
 * @param {string} path
 * @returns {T}  `override`, index-aligned to `next`
 */
function realign(prev, next, override, orphans, path) {
    return /** @type {T} */ (realignValue(prev, next, override, orphans, path));
}

/**
 * @param {unknown} prev
 * @param {unknown} next
 * @param {unknown} override
 * @param {Record<string, any>} orphans
 * @param {string} path
 * @returns {unknown}
 */
function realignValue(prev, next, override, orphans, path) {
    if (override === undefined || override === null) return override;
    if (Array.isArray(override)) {
        if (!Array.isArray(prev) || !Array.isArray(next)) return override;
        return realignArray(prev, next, override, orphans, path);
    }
    if (isRecord(override)) {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const k of Object.keys(override)) {
            out[k] = realignValue(isRecord(prev) ? prev[k] : undefined,
                isRecord(next) ? next[k] : undefined, override[k], orphans, `${path}.${k}`);
        }
        return out;
    }
    return override;
}

/**
 * @param {string} path
 */
function realignArray(prev, next, override, orphans, path) {
    if (JSON.stringify(prev) === JSON.stringify(next)) return override;
    const claimed = new Array(prev.length).fill(false);
    /** @type {number[]} */
    const from = new Array(next.length).fill(-1);
    const prevJson = prev.map((p) => JSON.stringify(p));
    // 1. by id
    next.forEach((n, i) => {
        if (!isPlainObject(n) || typeof n.id !== 'string' || n.id === '') return;
        const j = prev.findIndex((p, pj) => !claimed[pj] && isPlainObject(p) && p.id === n.id);
        if (j >= 0) { claimed[j] = true; from[i] = j; }
    });
    // 2. by identical content
    next.forEach((n, i) => {
        if (from[i] >= 0) return;
        const nj = JSON.stringify(n);
        const j = prevJson.findIndex((pj, k) => !claimed[k] && pj === nj);
        if (j >= 0) { claimed[j] = true; from[i] = j; }
    });
    // 3. a parked translation of this very item
    /** @type {Record<number, any>} */
    const revived = {};
    next.forEach((n, i) => {
        if (from[i] >= 0) return;
        const bagKey = `${path}#${itemKey(n)}`;
        if (Object.prototype.hasOwnProperty.call(orphans, bagKey)) {
            revived[i] = orphans[bagKey];
            delete orphans[bagKey];
        }
    });
    // 4. same position, if that old slot found no successor
    next.forEach((_n, i) => {
        if (from[i] >= 0 || i in revived || i >= prev.length || claimed[i]) return;
        claimed[i] = true; from[i] = i;
    });
    // Park the translations of items that are gone.
    prev.forEach((p, j) => {
        if (claimed[j] || j >= override.length || override[j] === null || override[j] === undefined) return;
        orphans[`${path}#${itemKey(p)}`] = override[j];
    });
    return next.map((n, i) => {
        if (i in revived) return revived[i];
        const j = from[i];
        return j < 0 || j >= override.length ? null : realignValue(prev[j], n, override[j], orphans, `${path}[]`);
    });
}

/**
 * Re-align one override root; keeps the parked translations in `_orphans`.
 * @param {Record<string, any>} root  { content | header | footer, _orphans? }
 * @param {string[]} keys  the keys of `root` that hold default-language-shaped data
 * @param {(key: string) => any} prevOf
 * @param {(key: string) => any} nextOf
 */
function realignRoot(root, keys, prevOf, nextOf) {
    const orphans = isPlainObject(root._orphans) ? { ...root._orphans } : {};
    const out = { ...root };
    for (const k of keys) {
        if (root[k] !== undefined) out[k] = realignValue(prevOf(k), nextOf(k), root[k], orphans, k);
    }
    const names = Object.keys(orphans);
    if (names.length) out._orphans = Object.fromEntries(names.slice(-ORPHAN_CAP).map((n) => [n, orphans[n]]));
    else delete out._orphans;
    return out;
}

/** @param {string} key @param {string} infix */
function localeOf(key, infix) {
    return key.substring(key.lastIndexOf(infix) + infix.length);
}

/**
 * Inside a content write: re-align every locale override of a page.
 * @param {ConfigIo} io
 * @param {string} siteId
 * @param {unknown} prevPage  the stored page before the save (or null)
 * @param {{ id?: string, blocks?: unknown }} nextPage  the page as saved
 * @returns {Promise<Record<string, any>>}  locale -> re-aligned override (only those that changed)
 */
async function realignPageOverrides(io, siteId, prevPage, nextPage) {
    /** @type {Record<string, any>} */
    const changed = {};
    if (!isRecord(prevPage) || !Array.isArray(prevPage.blocks) || !Array.isArray(nextPage?.blocks)) return changed;
    const prefix = `${pageKey(siteId, nextPage.id)}${KEY_LOCALE_INFIX}`;
    const keys = (await io.keysLike(`${prefix}%`)).filter((k) => k.startsWith(prefix));
    const prevById = new Map(prevPage.blocks.map((/** @type {StoredBlock} */ b) => [b.id, b]));
    const nextById = new Map(nextPage.blocks.map((/** @type {StoredBlock} */ b) => [b.id, b]));
    for (const key of keys) {
        const ov = await io.get(key);
        if (!isPlainObject(ov) || !isPlainObject(ov.blocks)) continue;
        /** @type {Record<string, any>} */
        const blocks = {};
        for (const [blockId, blockOv] of Object.entries(ov.blocks)) {
            const p = prevById.get(blockId);
            const n = nextById.get(blockId);
            blocks[blockId] = p && n && isPlainObject(blockOv)
                ? realignRoot(blockOv, ['content'], () => p.content, () => n.content)
                : blockOv;
        }
        const next = { ...ov, blocks };
        if (JSON.stringify(next) !== JSON.stringify(ov)) {
            await io.set(key, next);
            changed[localeOf(key, KEY_LOCALE_INFIX)] = next;
        }
    }
    return changed;
}

/**
 * Inside a site write: re-align every site-locale override (header/footer).
 * @param {ConfigIo} io
 * @param {string} siteId
 * @param {unknown} prevSite
 * @param {unknown} nextSite
 * @returns {Promise<Record<string, any>>}  locale -> re-aligned override (only those that changed)
 */
async function realignSiteOverrides(io, siteId, prevSite, nextSite) {
    /** @type {Record<string, any>} */
    const changed = {};
    if (!isRecord(prevSite) || !isRecord(nextSite)) return changed;
    const prefix = projectLocaleKey(siteId, '');
    const keys = (await io.keysLike(`${prefix}%`)).filter((k) => k.startsWith(prefix));
    for (const key of keys) {
        const ov = await io.get(key);
        if (!isPlainObject(ov)) continue;
        const next = realignRoot(ov, ['header', 'footer'], (k) => prevSite[k], (k) => nextSite[k]);
        if (JSON.stringify(next) !== JSON.stringify(ov)) {
            await io.set(key, next);
            changed[localeOf(key, KEY_LOCALE_INFIX)] = next;
        }
    }
    return changed;
}

/**
 * Write a site document and re-align its site-locale overrides in ONE
 * transaction locked on the site key. `report.localeOverrides` receives the
 * overrides that moved (locale -> override) so the caller can hand them to the editor.
 * With `expectedRev`, the stored site must still be at that chrome revision
 * (409 otherwise); the stored revision is raised when `bumpRev`, and the one
 * stored is reported as `report.rev`.
 * @param {string} siteId
 * @param {Record<string, unknown>} sanitized
 * @param {{ localeOverrides?: Record<string, any>, rev?: number }} [report]
 * @param {{ expectedRev?: number, bumpRev?: boolean }} [opts]
 */
async function writeSiteAligned(siteId, sanitized, report, { expectedRev, bumpRev = true } = {}) {
    const key = projectKey(siteId);
    const { moved, rev } = await withConfigGroup(key, async (io) => {
        const previous = await io.get(key);
        assertRevMatches(previous, expectedRev, 'site');
        const nextRev = bumpRev ? revOf(previous) + 1 : revOf(previous);
        await io.set(key, { ...sanitized, rev: nextRev });
        return { moved: await realignSiteOverrides(io, siteId, previous, sanitized), rev: nextRev };
    });
    if (report) { report.localeOverrides = moved; report.rev = rev; }
}

/**
 * Write a page document and re-align its locale overrides in ONE transaction
 * locked on the page key. Returns the overrides that moved (locale -> override).
 * With `expectedRev`, the stored page must still be at that revision (409
 * otherwise, and nothing, overrides included, is written). The revision is
 * raised on every write; the one stored is reported as `report.rev`.
 * @param {string} siteId
 * @param {{ id: string, blocks?: unknown }} sanitized
 * @param {{ expectedRev?: number, report?: { rev?: number } }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
function writePageAligned(siteId, sanitized, { expectedRev, report } = {}) {
    const key = pageKey(siteId, sanitized.id);
    return withConfigGroup(key, async (io) => {
        const previous = await io.get(key);
        assertRevMatches(previous, expectedRev, 'page');
        const rev = revOf(previous) + 1;
        await io.set(key, { ...sanitized, rev });
        if (report) report.rev = rev;
        return realignPageOverrides(io, siteId, previous, sanitized);
    });
}

module.exports = { realign, realignRoot, realignPageOverrides, realignSiteOverrides, writeSiteAligned, writePageAligned, withConfigGroup };
