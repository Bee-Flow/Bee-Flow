/**
 * Wat een LEZER van een gepubliceerde pagina krijgt, en hoe die momentopname
 * ontstaat (W2).
 *
 * Uit routes/webpages.js gehaald toen dat bestand werd opgesplitst: de
 * leeskant (`readSlotsForReader`) hoort bij GET /:id en GET /:id/files, de
 * pinkant (`pinPublishedVersion`) bij PATCH /:id/publish, en `liveMatchesPin`
 * bij de thumbnail — drie routes in twee modules, één waarheid over welke
 * bytes een niet-eigenaar mag zien.
 */

const webpageStore = require('../../stores/webpageStore');
const webpageDbStore = require('../../stores/webpageDbStore');
const log = require('../../telemetry/log');

/**
 * ── The published-snapshot read path (W2) ─────────────────────────────────
 *
 * `webpageStore.resolveReadVersion` answers WHICH bytes a caller gets; this
 * pair turns that answer into actual content, and it is deliberately the only
 * place in this file that reads slots for someone who is not the owner.
 *
 * The refusal path matters more than the happy one: a pointer whose version
 * row is gone (pruned, deleted, or belonging to another page) yields EMPTY
 * slots, never the live row. Falling back to live there would hand a reader
 * the owner's unpublished work — the exact failure the pointer exists to
 * prevent — and it would do it silently, which is worse.
 */
const EMPTY_SLOTS = Object.freeze({ html: '', css: '', js: '' });

async function readSlotsForReader(webpage, userId) {
    const ownerId = webpage.userId;
    const { versionId, fellBackToLive } = webpageStore.resolveReadVersion(webpage, userId);
    if (!versionId) {
        // The warning is scoped to a PUBLISHED page on purpose. A page read
        // through project membership (stores/webpage/access.canReadWebpageAsync)
        // may be unpublished and still legitimately shared — there is no
        // snapshot to honour there, and logging every such read would bury the
        // case that matters. THIS case is the one that matters: a page with a
        // real audience whose pointer is missing, i.e. published before the
        // column existed and not yet backfilled (migrations/webpage-published-
        // version-2026-09). Loud, because it is a read of unpublished bytes.
        if (fellBackToLive && webpage.isPublished) {
            log.warn(`[Webpages] ${webpage.id}: published with no pinned version — serving LIVE content to non-owner ${userId}`);
        }
        return { files: await webpageStore.readAllSlots(ownerId, webpage.id), servedVersionId: null };
    }
    const meta = await webpageStore.getVersionMeta(versionId);
    if (!meta || meta.webpageId !== webpage.id) {
        log.warn(`[Webpages] ${webpage.id}: published_version_id ${versionId} is missing — serving nothing`);
        return { files: { ...EMPTY_SLOTS }, servedVersionId: null, pinBroken: true };
    }
    return {
        files: await webpageStore.readAllSlots(ownerId, webpage.id, versionId),
        servedVersionId: versionId,
    };
}

/**
 * Is the live row byte-identical to the pinned snapshot? Used by the thumbnail
 * route, which has no per-version image to serve: the stored thumbnail is a
 * screenshot of the LIVE page, so it may only be shown to a non-owner while
 * live and published are the same three files. Unknown → false → no image.
 */
function liveMatchesPin(webpage, meta) {
    if (!meta) return false;
    return (webpage.htmlSha || '') === (meta.htmlSha || '')
        && (webpage.cssSha || '') === (meta.cssSha || '')
        && (webpage.jsSha || '') === (meta.jsSha || '');
}

/**
 * Freeze the current content as THE published snapshot and point the page at
 * it. Order is the safety property: flush → snapshot → pointer. A pointer
 * written before its version exists is a window in which readers get nothing;
 * a snapshot taken before the SQLite blob is flushed pins yesterday's data
 * (the manual-snapshot route at POST /:id/versions flushes for the same
 * reason).
 *
 * Returns the pinned version id, or null when nothing could be pinned — and
 * the caller must then NOT report a successful publish.
 */
async function pinPublishedVersion(webpageId, ownerId) {
    try { await webpageDbStore.flush(ownerId, webpageId); } catch (e) {
        log.warn('[Webpages] Pre-publish DB flush failed:', e.message);
    }
    const wp = await webpageStore.getWebpage(webpageId, ownerId);
    if (!wp) return null;
    const version = await webpageStore.createVersion(
        ownerId, webpageId, 'Published', {
            htmlSha: wp.htmlSha, cssSha: wp.cssSha, jsSha: wp.jsSha,
            contentLength: wp.htmlSize + wp.cssSize + wp.jsSize,
        }, 'published');
    const ok = await webpageStore.setPublishedVersion(webpageId, ownerId, version.id);
    return ok ? version.id : null;
}

module.exports = {
    EMPTY_SLOTS,
    readSlotsForReader,
    liveMatchesPin,
    pinPublishedVersion,
};
