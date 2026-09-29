// @typecheck
/**
 * Pasted text as a knowledge source.
 *
 * One snippet, typed by a person, stored once. There is no upstream to poll
 * and no file to re-read, so `manual` is the only mode and a refresh means
 * the same thing it means for an upload: re-chunk and re-embed the text we
 * already hold.
 *
 * That is not a no-op even though the text has not changed — it is what a
 * re-embed after an embedding-model switch needs (`POST /:id/reindex` drives
 * exactly this path), which is the one time every document in a knowledge
 * base genuinely must be processed again.
 */

const supportsModes = ['manual'];
const defaultMode = 'manual';

async function enumerate(source, ctx, deps) {
    const page = await deps.kbStore.listDocuments(ctx.kbId, {
        limit: 200, offset: 0, filters: { sourceId: source.id },
    });
    return (page || []).map(d => ({
        externalId: String(d.external_id || d.id),
        docId: d.id,
        title: d.title,
    }));
}

/**
 * Always false: a text source is only ever refreshed on purpose, and the
 * purpose (a model switch, or a retry) is precisely to do the work again.
 * Saying "unchanged" here would make `reindex` a no-op, which is the one
 * thing it must never be.
 */
function isUnchanged() {
    return false;
}

async function fetch(item, stored, ctx, deps) {
    const doc = await deps.kbStore.getDocument(item.docId);
    if (!doc) throw new Error('Document no longer exists');
    const content = doc.original_content || '';
    if (!content.trim()) throw new Error('This text source has no stored text');
    return {
        content,
        title: doc.title,
        sourceType: doc.source_type || 'text',
        sourceUri: doc.source_uri || null,
        sourceModifiedAt: doc.source_modified_at || null,
        sizeBytes: doc.size_bytes ?? null,
        mime: doc.mime || null,
    };
}

module.exports = { enumerate, fetch, isUnchanged, supportsModes, defaultMode };
