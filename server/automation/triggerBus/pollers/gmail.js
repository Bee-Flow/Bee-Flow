/**
 * Gmail pollers (mail.new, label.added), extracted verbatim from
 * ../../triggerBus.js. Both share the paginated history walk in
 * ./gmailHistory.js and the per-message enrichment below.
 *
 * `ctx` is the object triggerBus.js builds: `store()` returns the current
 * automationStore (swappable through triggerBus._setDepsForTests), the other
 * getters return the client / integration modules, required lazily as they
 * were inline. Everything that sits in the server's import cycle comes in
 * through it, so this module stays a leaf.
 */

const { walkGmailHistory } = require('./gmailHistory');
const log = require('../../../telemetry/log');

/** @param {any} ctx */
function createGmailPollers(ctx) {
    return {
        'mail.new': async (sub, session) => {
            const { createGoogleApiClient } = ctx.googleClient();
            const gmail = await createGoogleApiClient(session, { api: 'gmail', version: 'v1' });

            // Recoverable failure: history.list 404 / "Requested entity was
            // not found" / "invalid" means the cursor has aged out of
            // Gmail's ~7 day retention window. We drop the cursor and let
            // the bootstrap branch run on the next tick (or this tick after
            // re-entry). Without this the subscription was permanently
            // broken once it crossed the retention boundary.
            const isCursorStaleError = (err) => {
                const code = err?.code || err?.response?.status;
                const msg = String(err?.message || '').toLowerCase();
                return code === 404
                    || msg.includes('requested entity was not found')
                    || msg.includes('invalid history id')
                    || msg.includes('invalid_grant'); // expired refresh — surface but treat as stale
            };

            if (sub.lastCursor) {
                try {
                    // Paginated walk (./triggerBus/pollers/gmailHistory.js): a
                    // single-page read dropped every messageAdded beyond page 1
                    // while still advancing the cursor to the latest historyId.
                    // On the per-tick cap the cursor advances only to the LAST
                    // record processed, so the next tick continues from there.
                    const MAX_GMAIL_EVENTS = 100;
                    const seen = new Set();
                    const ids = [];
                    const walk = await walkGmailHistory(gmail, {
                        startHistoryId: sub.lastCursor,
                        historyTypes: ['messageAdded'],
                        maxEvents: MAX_GMAIL_EVENTS,
                        onRecord: (h) => {
                            for (const m of (h.messagesAdded || [])) {
                                const id = m.message?.id;
                                if (id && !seen.has(id)) { seen.add(id); ids.push({ id, threadId: m.message?.threadId }); }
                            }
                            return ids.length;
                        },
                    });

                    if (walk.capped) {
                        log.warn(`[TriggerBus] gmail sub ${sub.id}: large history backlog — processed ${ids.length} event(s) this tick, advancing cursor to ${walk.lastProcessedHistoryId}; the remainder is picked up next tick.`);
                    }
                    const events = [];
                    for (const { id, threadId } of ids) {
                        const enriched = await fetchGmailMessageMetadata(ctx, gmail, id).catch(() => null);
                        events.push({ messageId: id, threadId, ...(enriched || {}) });
                    }
                    if (walk.nextCursor) await ctx.store().updateSubscription(sub.id, { lastCursor: String(walk.nextCursor) });
                    return events;
                } catch (err) {
                    if (isCursorStaleError(err)) {
                        log.warn(`[TriggerBus] gmail cursor ${sub.lastCursor} stale for sub ${sub.id} — clearing and re-bootstrapping. (${err.message})`);
                        await ctx.store().updateSubscription(sub.id, { lastCursor: null });
                        // Fall through to the bootstrap branch below.
                    } else {
                        log.warn('[TriggerBus] gmail poll error:', err.message);
                        return [];
                    }
                }
            }

            // Bootstrap branch. Used on first poll AND after a cursor reset.
            //
            // Rather than `getProfile()` (which only returns the current
            // historyId and gives the user a silent no-op on activate), we
            // pull the most recent matching message via messages.list. That:
            //   1. anchors the cursor at a definitely-fresh historyId, and
            //   2. lets us optionally surface that message as the "first"
            //      event so activation immediately produces a run.
            //
            // We do NOT auto-deliver the bootstrap message here, because
            // that's already handled by the immediate-dispatch path in
            // routes/automation.js POST /:id/activate. Returning it twice
            // would double-fire the automation. So this branch only
            // anchors the cursor.
            try {
                const list = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
                const newest = list.data.messages?.[0];
                if (newest?.id) {
                    const meta = await gmail.users.messages.get({
                        userId: 'me', id: newest.id, format: 'metadata', metadataHeaders: ['Date'],
                    });
                    const hid = meta.data.historyId;
                    if (hid) {
                        await ctx.store().updateSubscription(sub.id, { lastCursor: String(hid) });
                        log.info(`[TriggerBus] gmail bootstrap sub ${sub.id} anchored at historyId=${hid}`);
                        return [];
                    }
                }
                // Empty mailbox or no messages.list result — fall back to profile.
                const profile = await gmail.users.getProfile({ userId: 'me' });
                if (profile.data.historyId) {
                    await ctx.store().updateSubscription(sub.id, { lastCursor: String(profile.data.historyId) });
                    log.info(`[TriggerBus] gmail bootstrap sub ${sub.id} anchored at profile historyId=${profile.data.historyId}`);
                }
                return [];
            } catch (e) {
                log.warn('[TriggerBus] gmail bootstrap error:', e.message);
                return [];
            }
        },

        /**
         * label.added — fires when a label is applied to a message. Reuses
         * the same Gmail history machinery as mail.new but watches a
         * different `historyType`. Bootstrap path is identical.
         */
        'label.added': async (sub, session) => {
            const { createGoogleApiClient } = ctx.googleClient();
            const gmail = await createGoogleApiClient(session, { api: 'gmail', version: 'v1' });

            const isCursorStaleError = (err) => {
                const code = err?.code || err?.response?.status;
                const msg = String(err?.message || '').toLowerCase();
                return code === 404
                    || msg.includes('requested entity was not found')
                    || msg.includes('invalid history id')
                    || msg.includes('invalid_grant');
            };

            if (sub.lastCursor) {
                try {
                    // Group label-added rows by messageId so a single
                    // message that picked up multiple labels in one batch
                    // fires once with all addedLabelIds aggregated.
                    // Paginated like mail.new: at most MAX_LABEL_EVENTS
                    // messages per tick, and on that cap the cursor stops at
                    // the last record drained instead of jumping to the
                    // newest historyId (which silently dropped the rest).
                    const MAX_LABEL_EVENTS = 20;
                    const byMsg = new Map();
                    const walk = await walkGmailHistory(gmail, {
                        startHistoryId: sub.lastCursor,
                        historyTypes: ['labelAdded'],
                        maxEvents: MAX_LABEL_EVENTS,
                        onRecord: (h) => {
                            for (const la of (h.labelsAdded || [])) {
                                const id = la.message?.id;
                                if (!id) continue;
                                const existing = byMsg.get(id) || { messageId: id, threadId: la.message?.threadId, addedLabelIds: [] };
                                for (const lid of (la.labelIds || [])) {
                                    if (!existing.addedLabelIds.includes(lid)) existing.addedLabelIds.push(lid);
                                }
                                byMsg.set(id, existing);
                            }
                            return byMsg.size;
                        },
                    });
                    if (walk.capped) {
                        log.warn(`[TriggerBus] gmail label sub ${sub.id}: large history backlog — processed ${byMsg.size} message(s) this tick, advancing cursor to ${walk.lastProcessedHistoryId}; the remainder is picked up next tick.`);
                    }
                    // Every collected message is dispatched: the cursor has
                    // moved past all of their records, so none may be dropped.
                    const events = [];
                    for (const ev of byMsg.values()) {
                        const enriched = await fetchGmailMessageMetadata(ctx, gmail, ev.messageId).catch(() => null);
                        events.push({ ...ev, ...(enriched || {}) });
                    }
                    if (walk.nextCursor) await ctx.store().updateSubscription(sub.id, { lastCursor: String(walk.nextCursor) });
                    return events;
                } catch (err) {
                    if (isCursorStaleError(err)) {
                        log.warn(`[TriggerBus] gmail label cursor ${sub.lastCursor} stale for sub ${sub.id} — clearing.`);
                        await ctx.store().updateSubscription(sub.id, { lastCursor: null });
                    } else {
                        log.warn('[TriggerBus] gmail label poll error:', err.message);
                        return [];
                    }
                }
            }

            // Bootstrap — anchor at the current historyId without delivering historic events.
            try {
                const list = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
                const newest = list.data.messages?.[0];
                if (newest?.id) {
                    const meta = await gmail.users.messages.get({
                        userId: 'me', id: newest.id, format: 'metadata', metadataHeaders: ['Date'],
                    });
                    if (meta.data.historyId) {
                        await ctx.store().updateSubscription(sub.id, { lastCursor: String(meta.data.historyId) });
                        log.info(`[TriggerBus] gmail.label.added bootstrap sub ${sub.id} anchored at historyId=${meta.data.historyId}`);
                        return [];
                    }
                }
                const profile = await gmail.users.getProfile({ userId: 'me' });
                if (profile.data.historyId) {
                    await ctx.store().updateSubscription(sub.id, { lastCursor: String(profile.data.historyId) });
                }
                return [];
            } catch (e) {
                log.warn('[TriggerBus] gmail label bootstrap error:', e.message);
                return [];
            }
        },
    };
}

/**
 * Fetch the headers / snippet / labelIds for one Gmail message so the
 * mail.new event payload carries enough context for shallow filters
 * (e.g. `filter: { labelIds: ['Label_3'] }`) and downstream binding
 * (`{{trigger.output.subject}}`) without an extra round-trip.
 *
 * We use `format: 'full'` rather than 'metadata' so the payload also
 * exposes `attachments[]` (filename, mimeType, size, attachmentId). The
 * AI builder can then branch on `trigger.output.hasAttachment` and pass
 * `trigger.output.attachments[i].attachmentId` straight into
 * `gmail_read_attachment` — saving an extra `gmail_read` round-trip and
 * letting attachment bytes flow via `sourceHandle` to upload tools
 * without ever passing through the model context.
 */
async function fetchGmailMessageMetadata(ctx, gmail, messageId) {
    const { extractAttachments } = ctx.gmailTools();
    const r = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
    });
    const headers = r.data.payload?.headers || [];
    const get = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || null;
    const threadId = r.data.threadId || null;
    const attachments = extractAttachments(r.data.payload, { messageId, threadId }).map(a => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        attachmentId: a.attachmentId,
        // messageId + threadId so trigger.output.attachments[i] feeds
        // gmail_read_attachment directly (it needs both ids).
        messageId: a.messageId,
        threadId: a.threadId,
    }));
    return {
        from: get('From'),
        to: get('To'),
        cc: get('Cc'),
        subject: get('Subject') || '(no subject)',
        date: get('Date'),
        snippet: r.data.snippet || '',
        labelIds: r.data.labelIds || [],
        sizeEstimate: r.data.sizeEstimate || null,
        historyId: r.data.historyId || null,
        attachments,
        hasAttachment: attachments.length > 0,
    };
}

module.exports = { createGmailPollers, fetchGmailMessageMetadata };
