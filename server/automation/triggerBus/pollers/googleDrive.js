// @typecheck
/**
 * Google Drive poller (file.new via changes.list), extracted verbatim from
 * ../../triggerBus.js.
 *
 * `ctx` is the object triggerBus.js builds: `store()` returns the current
 * automationStore (swappable through triggerBus._setDepsForTests), the other
 * getters return the client / integration modules, required lazily as they
 * were inline. Everything that sits in the server's import cycle comes in
 * through it, so this module stays a leaf.
 */

const log = require('../../../telemetry/log');
const { fallback } = require('../../../utils/bestEffort');

const NEW_WINDOW_MS = 24 * 60 * 60_000;
const MAX_FIRED = 200;

/**
 * The cursor is the Drive page token, or JSON `{ p, fired }` once files have
 * fired: `fired` maps a file id to its createdTime (ms). A file counts as new
 * for 24 h after its creation, and every edit in that window is another
 * change row, so the ids that fired are kept until that window has closed.
 * @param {string} raw
 * @returns {{ pageToken: string, fired: Record<string, number> }}
 */
function parseCursor(raw) {
    if (raw.startsWith('{')) {
        let c = null;
        // Not ours when it does not parse: read as a page token below.
        try { c = JSON.parse(raw); } catch (err) { c = fallback('automation/triggerBus/pollers/googleDrive:parseCursor', err, null); }
        if (c && typeof c.p === 'string') return { pageToken: c.p, fired: { ...(c.fired || {}) } };
    }
    return { pageToken: raw, fired: {} };
}

/**
 * @param {string} pageToken
 * @param {Record<string, number>} fired
 * @param {number} nowMs
 */
function formatCursor(pageToken, fired, nowMs) {
    // A file created longer ago than the window cannot count as new again.
    const live = Object.entries(fired).filter(([, created]) => nowMs - created <= NEW_WINDOW_MS + 60 * 60_000);
    live.sort((a, b) => b[1] - a[1]);
    if (live.length === 0) return pageToken;
    return JSON.stringify({ p: pageToken, fired: Object.fromEntries(live.slice(0, MAX_FIRED)) });
}

/** @param {Pick<import('./gmail').PollerCtx, 'store' | 'googleClient'>} ctx */
function createGoogleDrivePollers(ctx) {
    return {
        /**
         * file.new — fires when a file is created in the user's Drive.
         * Bootstraps with `getStartPageToken`; subsequent ticks use
         * `changes.list({pageToken})` and emit creates only, once per file.
         */
        'file.new': async (sub, session) => {
            const { createGoogleApiClient } = ctx.googleClient();
            const drive = await createGoogleApiClient(session, { api: 'drive', version: 'v3' });

            const isStaleCursor = (err) => {
                const code = err?.code || err?.response?.status;
                const msg = String(err?.message || '').toLowerCase();
                return code === 404 || msg.includes('invalid_grant') || msg.includes('start page token');
            };

            if (!sub.lastCursor) {
                try {
                    const r = await drive.changes.getStartPageToken();
                    if (r.data?.startPageToken) {
                        await ctx.store().updateSubscription(sub.id, { lastCursor: String(r.data.startPageToken) });
                        log.info(`[TriggerBus] drive bootstrap sub ${sub.id} anchored at pageToken=${r.data.startPageToken}`);
                    }
                } catch (e) {
                    log.warn('[TriggerBus] drive bootstrap error:', /** @type {Error} */ (e).message);
                }
                return [];
            }

            const { pageToken, fired } = parseCursor(String(sub.lastCursor));
            try {
                const r = await drive.changes.list({
                    pageToken,
                    includeRemoved: false,
                    spaces: 'drive',
                    fields: 'changes(time,removed,fileId,file(id,name,mimeType,parents,createdTime,modifiedTime,owners(emailAddress,me),webViewLink,trashed)),newStartPageToken,nextPageToken',
                    pageSize: 100,
                });
                const events = [];
                for (const ch of (r.data.changes || [])) {
                    const f = ch.file;
                    if (!f || ch.removed || f.trashed) continue;
                    // Treat as "new" when createdTime is recent (within the
                    // last 24h relative to the change time). Modifications
                    // of older files have createdTime predating the change
                    // and are skipped.
                    const created = Date.parse(f.createdTime || '') || 0;
                    const changeT = Date.parse(ch.time || '') || Date.now();
                    if (changeT - created > NEW_WINDOW_MS) continue;
                    // A change to a file that already fired is an edit, not a new file.
                    if (Object.hasOwn(fired, f.id)) continue;
                    fired[f.id] = created;
                    events.push({
                        fileId: f.id,
                        name: f.name || '',
                        mimeType: f.mimeType || '',
                        parents: f.parents || [],
                        createdTime: f.createdTime || null,
                        owners: f.owners || [],
                        webViewLink: f.webViewLink || null,
                    });
                }
                const next = r.data.newStartPageToken || r.data.nextPageToken;
                const cursor = formatCursor(String(next || pageToken), fired, Date.now());
                if (cursor !== sub.lastCursor) await ctx.store().updateSubscription(sub.id, { lastCursor: cursor });
                return events;
            } catch (err) {
                if (isStaleCursor(err)) {
                    log.warn(`[TriggerBus] drive cursor ${sub.lastCursor} stale for sub ${sub.id} — clearing.`);
                    await ctx.store().updateSubscription(sub.id, { lastCursor: null });
                    return [];
                }
                log.warn('[TriggerBus] drive poll error:', /** @type {Error} */ (err).message);
                return [];
            }
        },
    };
}

module.exports = { createGoogleDrivePollers };
