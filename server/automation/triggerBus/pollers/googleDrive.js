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

/** @param {Pick<import('./gmail').PollerCtx, 'store' | 'googleClient'>} ctx */
function createGoogleDrivePollers(ctx) {
    return {
        /**
         * file.new — fires when a file is created in the user's Drive.
         * Bootstraps with `getStartPageToken`; subsequent ticks use
         * `changes.list({pageToken})` and emit creates only.
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

            try {
                const r = await drive.changes.list({
                    pageToken: sub.lastCursor,
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
                    if (changeT - created > 24 * 60 * 60_000) continue;
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
                if (next) await ctx.store().updateSubscription(sub.id, { lastCursor: String(next) });
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
