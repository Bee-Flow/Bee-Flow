'use strict';

/**
 * Processing one accepted project file (projectFiles.js): extract, screen,
 * deduplicate and embed it under its documents row.
 */

const DUPLICATE_REASON = 'The same file is already in this project.';

/**
 * @param {object} ctx
 * @param {() => object} ctx.kbStore
 * @param {() => object} ctx.helpers
 * @param {() => object} ctx.privacy
 * @param {object} ctx.log
 */
function makeFileProcessor(ctx) {
    const { kbStore, helpers, privacy, log } = ctx;

    /**
     * Extract, screen, deduplicate and embed one accepted file under its row.
     * Never throws; returns the outside status it ended in, or 'removed' when
     * the file was deleted while it was being processed.
     */
    async function processFile(kb, doc, upload, { userId }) {
        const h = helpers();
        const store = kbStore();
        const name = doc.title;
        const markFailed = async (status, statusReason) => {
            try { await store.updateDocumentStatus(doc.id, { status, statusReason, chunkCount: 0 }); } catch (e) {
                log.warn(`[ProjectFiles] could not record why "${doc.id}" failed:`, e.message);
            }
            return 'failed';
        };

        try {
            let text = '';
            let meta = {};
            try {
                const extracted = await h.extractFileContentWithMeta(upload.buffer, upload.mimetype, name);
                text = extracted?.text || '';
                meta = extracted?.meta || {};
            } catch (e) {
                log.warn(`[ProjectFiles] extraction failed for ${doc.id}: ${e.message}`);
                return await markFailed('error', h.friendlyError(e));
            }
            const pages = Array.isArray(meta.pages) && meta.pages.length ? meta.pages : null;

            // Privacy BEFORE the hash, as ingestDocument does it: what is hashed
            // is what is stored, and what is stored is what the policy allows.
            let status = 'processed';
            let piiStatus;
            let piiCategories;
            if (text && text.trim().length >= 3) {
                const { applyShield, OUTCOME } = privacy();
                const verdict = await applyShield({
                    orgId: kb.organization_id || null, userId, text, filename: name, pages,
                });
                piiStatus = verdict.piiStatus;
                piiCategories = verdict.piiCategories;
                if (verdict.outcome === OUTCOME.SKIPPED) {
                    await store.replaceDocumentContent(doc.id, {
                        status: 'skipped', statusReason: verdict.reason, chunkCount: 0, piiStatus, piiCategories,
                    });
                    return 'failed';
                }
                text = verdict.text;
                if (verdict.outcome === OUTCOME.REDACTED) status = 'redacted';

                // The same content already in the project: an alias, not a
                // second embedding (the Knowledge Studio upload's rule).
                const existing = await store.findDocumentByContentHash(kb.id, store.hashContent(text));
                if (existing && String(existing.id) !== String(doc.id)) {
                    return await markFailed('duplicate', DUPLICATE_REASON);
                }
            }

            const result = await h.reingestDocument(kb.tenant_id, kb.id, doc.id, text, {
                title: name,
                sizeBytes: upload.size != null ? upload.size : (upload.buffer ? upload.buffer.length : null),
                mime: upload.mimetype || null,
                pageCount: Number.isFinite(meta.pageCount) ? meta.pageCount : null,
                sheetCount: Array.isArray(meta.sheetNames) ? meta.sheetNames.length : null,
                pages,
                externalId: name,
                onFailure: 'record',
                status,
                piiStatus,
                piiCategories,
            });

            // Removed while it was being embedded: its chunks may have landed
            // after the row went, and deleted text must not stay searchable.
            if (!(await store.getDocument(doc.id))) {
                await h.purgeDocumentChunks(kb.id, doc.id, kb.tenant_id).catch((e) => {
                    log.warn(`[ProjectFiles] could not purge chunks of removed file ${doc.id}:`, e.message);
                });
                return 'removed';
            }
            return result && (result.status === 'processed' || result.status === 'redacted') ? 'ready' : 'failed';
        } catch (e) {
            if (e && e.code === 'NOT_FOUND') return 'removed';
            log.error(`[ProjectFiles] processing ${doc.id} failed:`, e && e.message ? e.message : e);
            return await markFailed('error', h.friendlyError(e));
        }
    }

    return processFile;
}

module.exports = { makeFileProcessor, DUPLICATE_REASON };
