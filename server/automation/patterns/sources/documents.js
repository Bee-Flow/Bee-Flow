// @typecheck
'use strict';
/**
 * Pattern source: documents the user uploaded into a knowledge base by hand.
 *
 * Only `source_type = 'upload'` rows the user created themselves count. That
 * is an allow-list on purpose: a connector refresh (a Nextcloud folder, a
 * meeting tag, a data table) and an automation's knowledge write add rows on a
 * perfectly regular clock and also carry a `created_by` (the person who set
 * the source up), so attribution alone would turn every sync into a false
 * "file drop" pattern. Duplicate rows (the same content offered again) are
 * left out as well.
 *
 * An event is the file name as a template plus an opaque key for the
 * knowledge base it went into: "the same kind of file, the same place".
 * A table or column an older install lacks reads as "no uploads".
 */

const { makeEvent } = require('../events');
const { filenameStem } = require('../templating');
const { toMs, inWindow, opaqueKey, defaultDb, queryRows } = require('./common');

const MANUAL_SOURCE_TYPES = Object.freeze(['upload']);
const ROW_LIMIT = 2000;

/** @typedef {import('./common').Db} Db */

/**
 * @param {{ userId: string, since: number, now: number, deps?: { db?: Db } }} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectDocumentUploads(ctx) {
    if (!ctx?.userId) return [];
    const rows = await queryRows(ctx.deps?.db || defaultDb(), `
        SELECT title, source_uri, knowledge_base_id, created_at
          FROM documents
         WHERE created_by = $1
           AND source_type = ANY($2::text[])
           AND created_at >= $3 AND created_at <= $4
           AND COALESCE(status, 'processed') <> 'duplicate'
         ORDER BY created_at DESC
         LIMIT ${ROW_LIMIT}`,
    [String(ctx.userId), [...MANUAL_SOURCE_TYPES], new Date(ctx.since).toISOString(), new Date(ctx.now).toISOString()]);
    const out = [];
    for (const r of rows.reverse()) {
        const ts = toMs(r.created_at);
        const name = r.title || r.source_uri || '';
        if (!inWindow(ts, ctx) || !String(name).trim()) continue;
        const ev = makeEvent({
            ts,
            source: 'documents',
            objectType: 'document',
            app: 'beeflow',
            verb: 'doc.uploaded',
            template: filenameStem(name),
            sessionKey: r.knowledge_base_id ? opaqueKey('kb', String(r.knowledge_base_id)) : null,
        });
        if (ev) out.push(ev);
    }
    return out;
}

module.exports = { collectDocumentUploads, MANUAL_SOURCE_TYPES };
