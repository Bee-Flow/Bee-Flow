/**
 * Source Ingestion — Ingest various source types into a notebook's knowledge base.
 *
 * Supported types: pdf, docx, url, text, xlsx, csv, gdrive, onedrive
 * Each source is parsed → text extracted → chunked + embedded into the notebook's KB.
 *
 * Uses shared kbIngestionHelpers for extraction and ingestion, ensuring notebooks
 * get the same quality pipeline as standalone Knowledge Bases (Azure support,
 * OCR fallbacks, URL→Markdown, deduplication, etc.).
 */

const notebookStore = require('../../stores/notebookStore');
const kbStore = require('../../stores/knowledgeBases');
const { countWords } = require('../../utils/text');
const {
    extractFileContent,
    fetchUrlContent,
    ingestDocument,
} = require('../../core/kb/kbIngestionHelpers');
const log = require('../../telemetry/log');

/**
 * Ensure the notebook has a linked KB — auto-create one if needed.
 *
 * The knowledge base belongs to the NOTEBOOK's owner, whoever adds the first
 * source. It used to be created as the uploader's personal base: for a project
 * notebook, a member's first upload made a base the owner's notebook could
 * never attach (the attach is owner-scoped), so the source reported "ready"
 * and was never found. The notebook's own base is then authorised by notebook
 * role (notebookKbAccess.js), not by the generic KB ACL.
 *
 * It carries NO organisation. The generic KB ACL lets an org admin read every
 * base of their org, so an org stamp would hand them the uploaded files,
 * pasted text and transcripts of any member's private notebook; the people
 * the notebook is shared with already reach its base through its role.
 *
 * @returns {Promise<{ kbId: string, tenantId: string }>} the base and the tenant
 *   its chunks are stored (and searched, and deleted) under
 */
async function ensureNotebookKBFor(notebookId, userId) {
    const notebook = await notebookStore.getNotebook(notebookId, userId);
    if (!notebook) throw new Error('Notebook not found');
    const ownerId = notebook.userId || userId;

    let kbId = notebook.knowledgeBaseIds?.[0];

    if (!kbId) {
        const kb = await kbStore.createKB(
            ownerId,
            `📓 ${notebook.name}`,
            `Auto-generated knowledge base for notebook "${notebook.name}"`,
            null, // private to the notebook: see above
            { sourceKind: 'notebook_auto', usageContexts: ['webpage'] }
        );
        // Attach only if the notebook still has no KB. Uploading two sources at
        // once ran this whole function twice concurrently: both saw no kbId,
        // both created a KB, and the second plain update overwrote the first —
        // orphaning a KB whose source then reported "ready" but never matched a
        // single query. The database picks the winner now.
        const winnerId = await notebookStore.attachKnowledgeBaseIfAbsent(notebookId, ownerId, kb.id);
        if (winnerId !== kb.id) {
            // We lost the race — bin the KB we just made rather than leak it.
            log.info(`[SourceIngestion] Lost KB-create race for notebook ${notebookId}; using ${winnerId}`);
            try { await kbStore.deleteKB(kb.id); } catch (e) {
                log.warn(`[SourceIngestion] could not remove redundant KB ${kb.id}:`, e.message);
            }
        } else {
            log.info(`[SourceIngestion] Auto-created KB "${kb.name}" for notebook ${notebookId}`);
        }
        kbId = winnerId;
    }

    return { kbId, tenantId: ownerId };
}

/** The KB id only — the shape older callers use. */
async function ensureNotebookKB(notebookId, userId) {
    return (await ensureNotebookKBFor(notebookId, userId)).kbId;
}

/**
 * Core ingestion: push text content into the notebook's KB via shared helpers.
 *
 * @param {string} notebookId
 * @param {string} sourceId   — already created in notebook_sources
 * @param {string} userId
 * @param {string} text       — extracted text content
 * @param {string} sourceName — human label for the source
 */
// Normalize the human label used for a source — trim and collapse internal
// whitespace so names like "  My\tDoc \n " don't appear with stray tabs or
// newlines in the source list UI.
function normalizeSourceName(name, fallback = 'Untitled source') {
    if (!name) return fallback;
    const cleaned = String(name).replace(/\s+/g, ' ').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}

// The one error mapper (core/kb/friendlyError.js) — the KB source model
// stores the same sentences on documents.status_reason, so notebooks and
// knowledge bases must not drift into two vocabularies for one failure.
const { friendlyError } = require('../../core/kb/friendlyError');

// Cap stored extracted text so a giant upload can't bloat a DB row; enough for
// preview + text/meeting retry.
const MAX_STORED_TEXT = 1_000_000;

async function ingestTextIntoKB(notebookId, sourceId, userId, text, sourceName) {
    if (!text || text.length < 10) {
        await notebookStore.updateSource(sourceId, { status: 'ready', stage: 'ready', wordCount: 0, contentText: text || '' });
        return;
    }

    sourceName = normalizeSourceName(sourceName);
    const wordCount = countWords(text);

    try {
        // Store the extracted text first (powers the preview panel + retry) and
        // flip to the embedding stage so the UI shows real progress.
        await notebookStore.updateSource(sourceId, { stage: 'embedding', contentText: text.slice(0, MAX_STORED_TEXT) });
        const { kbId, tenantId: kbTenantId } = await ensureNotebookKBFor(notebookId, userId);

        // ── Privacy Shield: build the notebook's PII token map at INGEST ──────
        // The stored source text + embeddings stay REAL (search recall and the
        // data-owner preview depend on it). We scan the WHOLE source ONCE to mint
        // and PERSIST a token for every PII entity into the notebook's map
        // (notebooks.pii_token_map, keyed on notebookId). Previously the map was
        // built piecemeal at query time from whatever chunks a search happened to
        // retrieve, so a person who never landed in a retrieved chunk had no token
        // — and the model's `[person_N]` for them leaked into the drafted document
        // because the restore map didn't contain it. Building it here makes the map
        // complete + stable up front: later turns tokenise retrieved chunks
        // consistently (seeded from this map) and the AI-written document/chat
        // de-tokenise fully. Best-effort — never block ingestion on it.
        try {
            const { resolveShieldFor } = require('../../core/privacy/orgShield');
            const shield = await resolveShieldFor({ userId });
            if (shield?.enabled) {
                // Hydrate any existing notebook map first so a second source in the
                // same dossier reuses tokens (one [person_1] across all sources).
                try { await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(notebookId); } catch (_) { /* best-effort */ }
                // Warm the scan ledger with this source's segments.
                //
                // Ingestion already reads every byte of the source; recording the
                // per-segment verdicts here is what makes the FIRST chat turn cheap
                // instead of only the second. It works across the four different
                // string shapes the chat path builds from these same characters
                // (wrapped chunks, tool-result JSON, the document body) because the
                // segmentation is content-defined: the same bytes segment the same
                // way wherever they end up.
                //
                // Best-effort by design — a cold ledger costs time, never
                // correctness, and ingestion must not fail over a memo.
                try {
                    const { detectWithLedger } = require('../../core/dlp/scanLedger');
                    const cats = Array.isArray(shield?.piiDetectionCategories) && shield.piiDetectionCategories.length
                        ? shield.piiDetectionCategories : null;
                    const thr = Number.isFinite(shield?.piiDetectionConfidenceThreshold)
                        ? shield.piiDetectionConfidenceThreshold : undefined;
                    const warm = await detectWithLedger(text, { categories: cats, threshold: thr, scope: 'g' });
                    log.info(`[SourceIngestion] ledger warmed for "${sourceName}": `
                        + `segments=${warm.stats.segments} hits=${warm.stats.hits} fresh=${warm.stats.fresh}`);
                } catch (warmErr) {
                    log.warn(`[SourceIngestion] ledger warm-up skipped for "${sourceName}": ${warmErr.message}`);
                }

                const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
                // We deliberately discard the tokenised text — only the side-effect
                // (mint + mergeTokenMap → persist) matters; storage stays REAL.
                // Ingestion is background + non-interactive: give it a GENEROUS
                // budget and force fail_open so a big legal dossier is never
                // blocked/held (the opposite of what those users want) — we just
                // want the token map as complete as possible.
                const scan = await scanAttachmentText({
                    text, filename: sourceName,
                    orgShield: { ...shield, attachmentLargeInputPolicy: 'fail_open' },
                    conversationId: notebookId,
                    maxPages: 300,
                    maxScanMs: 80000,
                });
                if (scan?.action === 'tokenize') {
                    const n = Array.isArray(scan.findings) ? scan.findings.length : 0;
                    log.warn(`[SourceIngestion] 🔒 Built PII token map for "${sourceName}" (${n} spans) → notebook ${notebookId}`);
                }
                if (scan?.summary?.reason) {
                    // The map is INCOMPLETE for this source (too large / timed out /
                    // degraded): PII in the unscanned region won't tokenise
                    // consistently in AI-drafted output. Surface for admins.
                    log.warn(`[SourceIngestion] ⚠️ PII token map for "${sourceName}" is INCOMPLETE (${scan.summary.reason}) — unscanned regions may leak into drafted documents.`);
                }
            }
        } catch (piiErr) {
            log.warn(`[SourceIngestion] PII map build failed for "${sourceName}": ${piiErr.message}`);
        }

        // Use shared ingestion (dedup + chunk + embed)
        // Stored under the notebook owner's tenant, like the base itself: the
        // search and the cleanup of a source both run under that tenant, so a
        // colleague's upload is found and removed like the owner's own.
        const result = await ingestDocument(
            kbTenantId, kbId, text, sourceName,
            'notebook_source', sourceId,
            {
                skipDedup: false, lang: 'auto',
                // Who added it: a member's upload lands in the owner's tenant.
                createdBy: userId || null,
                // EXPLICIT opt-out of the knowledge-base privacy screen (K4).
                // This path already scans with its OWN policy and deliberately
                // keeps the real text — the source list shows it back to the
                // person who added it. Redacting underneath that would change
                // what this feature stores without anyone asking, so the null
                // is written down rather than left to the default.
                privacy: null,
            }
        );

        await notebookStore.updateSource(sourceId, { status: 'ready', stage: 'ready', wordCount });
        log.info(`[SourceIngestion] Source "${sourceName}" ingested: ${result.chunks} chunks, ${wordCount} words`);
    } catch (e) {
        // Duplicates are not fatal for notebook sources — mark ready, but flag it
        // so the UI can show a "duplicate" badge.
        if (e.code === 'DUPLICATE') {
            log.info(`[SourceIngestion] Duplicate content for "${sourceName}", marking ready`);
            const cur = await notebookStore.getSource(sourceId).catch(() => null);
            await notebookStore.updateSource(sourceId, { status: 'ready', stage: 'ready', wordCount, metadata: { ...(cur?.metadata || {}), duplicate: true } });
            return;
        }
        log.error(`[SourceIngestion] Failed to ingest "${sourceName}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', stage: 'error', error: friendlyError(e) });
    }
}

/**
 * Ingest a file buffer (PDF, DOCX, XLSX, etc.) — uses shared extraction
 * which includes Azure Document Intelligence + Mistral OCR fallbacks.
 */
async function ingestFileSource(notebookId, sourceId, userId, buffer, fileName, mimeType) {
    try {
        await notebookStore.updateSource(sourceId, { stage: 'extracting' });
        const text = await extractFileContent(buffer, mimeType, fileName);
        await ingestTextIntoKB(notebookId, sourceId, userId, text, fileName);
    } catch (e) {
        log.error(`[SourceIngestion] File parse failed for "${fileName}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', stage: 'error', error: friendlyError(e) });
    }
}

/**
 * Ingest a URL — uses shared URL→Markdown conversion (htmlToMarkdown)
 * instead of naive HTML stripping.
 */
async function ingestUrlSource(notebookId, sourceId, userId, url) {
    try {
        await notebookStore.updateSource(sourceId, { stage: 'fetching' });
        const { content, title, resolvedUrl } = await fetchUrlContent(url);

        await notebookStore.updateSource(sourceId, {
            metadata: { url: resolvedUrl, charCount: content.length },
            name: normalizeSourceName(title || url, url)
        });

        await ingestTextIntoKB(notebookId, sourceId, userId, content, resolvedUrl);
    } catch (e) {
        log.error(`[SourceIngestion] URL fetch failed for "${url}":`, e.message);
        await notebookStore.updateSource(sourceId, { status: 'error', stage: 'error', error: friendlyError(e) });
    }
}

/**
 * Ingest pasted text directly.
 */
async function ingestTextSource(notebookId, sourceId, userId, text, name) {
    await ingestTextIntoKB(notebookId, sourceId, userId, text, name || 'Pasted text');
}

/**
 * Ingest content from Google Drive (already exported as text by the frontend picker).
 */
async function ingestDriveSource(notebookId, sourceId, userId, content, fileName) {
    await ingestTextIntoKB(notebookId, sourceId, userId, content, fileName);
}

module.exports = {
    ingestFileSource,
    ingestUrlSource,
    ingestTextSource,
    ingestDriveSource,
    ingestTextIntoKB,
    ensureNotebookKB,
    ensureNotebookKBFor,
    MAX_STORED_TEXT,
};
