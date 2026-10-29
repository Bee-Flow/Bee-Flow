/**
 * Knowledge Base Ingest — a AUTOMATION-ONLY automation action (never exposed to
 * chat agents; it writes). Used by the "Resolved tickets → knowledge base"
 * template: an ai_step distils a solved ticket into an article, then this tool
 * ingests it into the chosen KB with a source-link back to the ticket.
 *
 * Dedup delegates to the shared
 * kbIngestionHelpers.ingestDocument() path, which dedupes by exact content_hash
 * AND simhash64 near-duplicate (Hamming distance ≤3). Behaviour:
 *   - Same ticket re-resolved (same sourceUri) → refresh the article in place
 *     (delete old chunks, re-ingest) so it never duplicates.
 *   - A near-duplicate of a DIFFERENT ticket → handled by `nearDuplicateStrategy`
 *     (the template sets 'merge'): the prior + new article are merged/enriched
 *     into one richer entry via the shared LLM merge prompt, keeping a
 *     single canonical document. 'skip' keeps the first; 'replace' keeps latest.
 *   - Byte-identical content → skipped (the canonical doc already covers it).
 *
 * Tenant isolation: the target KB MUST belong to the running org (ctx.orgId).
 * System KBs and other orgs' KBs are refused.
 */

const knowledgeBases = require('../stores/knowledgeBases');
const { ingestDocument, findDocumentBySourceUri, deleteDocumentChunks } = require('../core/kb/kbIngestionHelpers');
const log = require('../telemetry/log');
const { bestEffort, fallback: fallbackSwallowed } = require('../utils/bestEffort');
const {
    KB_INGEST_TOOLS, isKbIngestTool, targetRefusal, mergeArticles: _mergeArticles, readMetadata: _readMetadata,
} = require('./kbIngestSupport');

const SOURCE_TYPE = 'support_ticket';

/**
 * Where a write came from — it decides how the document is FILED, not whether
 * it is allowed.
 *
 * This tool was built for one caller (a resolved support ticket, distilled),
 * so `support_ticket` / `provider: support` were constants. K10 gave every
 * automation a `knowledge_write` step that comes through the same door, and a
 * nightly system summary filed as a support ticket is wrong in the Sources
 * list, wrong in the document's metadata, and wrong to anyone later asking
 * where a paragraph came from.
 *
 * `support` stays the DEFAULT so the existing callers are unchanged.
 */
const ORIGINS = Object.freeze({
    support: { sourceType: SOURCE_TYPE, provider: 'support', defaultTitle: 'Support article' },
    automation: { sourceType: 'automation_write', provider: 'automation', defaultTitle: 'Untitled' },
});
function originOf(context) { return ORIGINS[context && context.origin] || ORIGINS.support; }

/**
 * The kb_sources row this action's documents hang off: one `automation` source
 * per automation when the runner tells us which automation is running, otherwise one
 * shared "Automation ingest" source per KB.
 *
 * Never throws — the source is bookkeeping, the article is the product.
 * @param {string} kbId
 */
async function _ensureAutomationSource(kbId, context = {}) {
    const { ensureKbSource } = require('../core/kb/sources/ensureSource');
    const automationId = context.automationId || null;
    const origin = originOf(context);
    return ensureKbSource(kbId, 'automation', {
        // The automation's own title when the caller knows it: "Automation
        // 4f2c-…" in the Sources list tells a person nothing about what keeps
        // adding documents to their knowledge base.
        name: context.automationTitle || (automationId ? `Automation ${automationId}` : 'Automation ingest'),
        config: { provider: origin.provider, sourceType: origin.sourceType, ...(automationId ? { automationId } : {}) },
        // Matched on the automation id where there is one, so re-titling a
        // automation updates its source rather than creating a second.
        configMatch: automationId ? { automationId } : { sourceType: origin.sourceType },
        createdBy: context.userId || null,
    });
}

/**
 * Replace an existing document's content in place: delete its chunks + record,
 * then re-ingest under the SAME canonical sourceUri (skipDedup so it is never
 * rejected as its own duplicate). Carries `article` + `mergedSources` metadata
 * so future merges have the prior text and full provenance.
 */
/**
 * Replace a document's content in place, keeping its row and its source_uri.
 *
 * The MORE travelled of the two ingest paths, not the less: an automation with a
 * sourceUri comes through here on every run after the first.
 *
 * It DELETES BEFORE IT INGESTS, and with `skipSnapshot`, so there is no version
 * to restore from. That is only safe while nothing in between can refuse: the
 * privacy screen therefore runs in `executeKbIngestTool` BEFORE this is
 * entered, and `opts.pii` carries its verdict here rather than a policy this
 * function would have to apply itself.
 * @param {string} tenantId
 * @param {string} kbId
 * @param {string} article
 * @param {string} title
 * @param {string} lang
 */
async function _refreshInPlace(tenantId, kbId, existingDoc, article, title, lang, extraMeta = {}, sourceId = null, opts = {}) {
    const origin = opts.origin || ORIGINS.support;
    const canonicalUri = existingDoc.source_uri || null;
    const prevMeta = _readMetadata(existingDoc);
    // skipSnapshot: this row is being replaced by its own source, not deleted
    // by a person — a snapshot per refresh would copy the full article into
    // kb_document_versions, a table with no erasure path.
    await deleteDocumentChunks(kbId, existingDoc.id, tenantId, { skipSnapshot: true }).catch((e) => bestEffort('integrations/kbIngestTools:_refreshInPlace', e));
    const metadata = {
        ingestedBy: 'automation',
        sourceUri: canonicalUri,
        ...prevMeta,
        // AFTER prevMeta, deliberately. Spreading the old metadata over the new
        // origin put the previous run's `support_ticket` straight back, so a
        // automation's article kept being re-filed as a support ticket on every
        // refresh — which is every run after the first.
        source_type: origin.sourceType, provider: origin.provider,
        ...extraMeta, article,
    };
    const res = await ingestDocument(tenantId, kbId, article, title, origin.sourceType, canonicalUri, {
        skipDedup: true, lang: lang || 'auto', metadata,
        sourceId: sourceId || existingDoc.source_id || null,
        externalId: canonicalUri,
        // NOT screened here — executeKbIngestTool screens once, BEFORE this
        // function deletes anything. See the comment there.
        privacy: null,
        ...(opts.pii || {}),
    });
    return res;
}

/**
 * @param {string} toolName
 */
async function executeKbIngestTool(toolName, args = {}, context = {}) {
    try {
        if (!isKbIngestTool(toolName)) return { error: `Unknown tool: ${toolName}` };
        const orgId = context.orgId || null;
        const {
            knowledgeBaseId, title, content, sourceUri, lang,
            dedupe: dedupeArg, nearDuplicateStrategy = 'skip',
        } = args || {};
        /**
         * 'add' is not a fourth branch of the near-duplicate handling — it is
         * the ABSENCE of it: keep the sourceUri refresh (so the same subject
         * still replaces its own document) and stop the SIMHASH comparison from
         * folding a genuinely different subject into an existing article.
         *
         * It is NOT `dedupe: false`, which was the first attempt. That flag
         * turns off BOTH probes, and the other one is the exact content_hash
         * match — so "add it anyway" also meant "store a byte-identical copy
         * every night", which nobody asks for and which grows a base without
         * bound. It is handled at the simhash branch below instead.
         */
        const dedupe = dedupeArg === undefined ? true : dedupeArg;
        if (!knowledgeBaseId) return { error: 'knowledgeBaseId is required.' };
        const body = String(content || '').trim();
        if (!body) return { error: 'content is required.' };

        const kb = await knowledgeBases.getKB(knowledgeBaseId);
        const refusal = targetRefusal(kb, orgId);
        if (refusal) return refusal;

        /**
         * ── WHO IS WRITING, checked at RUN TIME (K10) ────────────────
         * The organisation test above was the only gate, and it is not one: it
         * let ANY author of ANY automation in an organisation write documents
         * into ANY of that organisation's knowledge bases — including one
         * shared with a group they are not in, and one they have no
         * `manage_knowledge` right over. An automation is a program somebody else
         * may run, so that was a write nobody reviewed reaching a base nobody
         * agreed to.
         *
         * Re-checked HERE, not only where the automation was saved, and keyed on
         * the identity this run actually has. An automation is saved once and runs
         * for months: the author's rights can be taken away, the base's
         * sharing can narrow, and the definition itself is data an import or
         * an MCP patch can put an id into. A stored definition is a record of
         * what somebody asked for, never evidence that it was allowed.
         *
         * `context.userId` is the automation's OWNER — the identity a run has
         * everywhere else in the product, so a trigger anyone can fire cannot
         * become a way to write as somebody else.
         */
        const writer = context.userId || null;
        if (writer) {
            const { canOwnerWriteToKb, messageFor } = require('../core/kb/kbWriteAccess');
            const verdict = await canOwnerWriteToKb(knowledgeBaseId, writer);
            if (!verdict.ok) {
                log.warn('[KBIngest] refused', JSON.stringify({
                    kbId: knowledgeBaseId, userId: writer, reason: verdict.reason,
                }));
                return { error: messageFor(verdict.reason, kb.name) };
            }
        } else {
            /**
             * No identity at all → refused, with no exemption.
             *
             * This arm used to let the write through when `context.inboxId` was
             * set, on the stated grounds that the support responder arrives
             * that way. It does not: the only two callers are
             * `core/tools/toolDispatcher.js` ({orgId, userId}) and
             * `execKnowledgeWrite` ({userId, orgId, automationId, …}), and
             * neither sets `inboxId` — `grep` finds it nowhere on this path.
             *
             * So the exemption was dead code carrying a comment that made it
             * look load-bearing, which is worse than no exemption: the next
             * caller to set `inboxId` for an unrelated reason would have
             * inherited a free pass nobody meant to grant.
             */
            log.warn('[KBIngest] refused: no identity for the write', JSON.stringify({ kbId: knowledgeBaseId }));
            return { error: 'This knowledge base write has no identity behind it.' };
        }

        /**
         * ── PRIVACY SHIELD AT INGEST (K4), ON THIS DOOR TOO ─────────
         * `ingestDocument` screens text only when a caller asks it to, and
         * this caller never did — so everything arriving through this tool
         * went into a knowledge base unscreened. That was survivable while the
         * only caller was the support template, whose prompt spends a
         * paragraph telling the model to strip personal data. K10 opened the
         * door to every automation: a `knowledge_write` step can be pointed
         * straight at a raw email body, a transcript, a customer conversation.
         *
         * A prompt asking a model to remove names is not a control. This is.
         * And what lands here is text an agent later quotes back with a
         * citation, which is the worst place for a name to survive.
         *
         * `applyShield` is a no-op for an organisation that never switched the
         * shield on (it returns the text unchanged and marks nothing), so this
         * changes nothing for anyone who did not ask for it.
         */
        /**
         * ── SCREENED HERE, BEFORE ANYTHING IS DELETED ────────────────
         * The screen is not handed DOWN to ingestDocument, on both paths.
         * On the refresh path that is a data-loss bug: `_refreshInPlace`
         * deletes the existing document first (with skipSnapshot, so there is
         * no version to restore) and ingests second — so a refusal landing in
         * between destroyed the article it was replacing and left an empty
         * `skipped` row. And a refusal is not exotic: the shield returns
         * SKIPPED for an org set to `block`, AND for any incomplete scan under
         * the DEFAULT fail-closed mode — a guard service degraded for a minute
         * is enough.
         *
         * So the verdict is taken once, up front, and the already-screened
         * text is what flows on (`privacy: null` below — screening twice would
         * tokenise the tokens).
         */
        const { applyShield, OUTCOME } = require('../core/kb/ingestPrivacy');
        let screened = { outcome: OUTCOME.PASS, text: body };
        try {
            screened = await applyShield({
                orgId: orgId || null,
                userId: context.userId || null,
                text: body,
                filename: title || 'document',
            });
        } catch (e) {
            // A screen that cannot run has not run. Refuse rather than store
            // text nobody looked at — the direction K4 chose everywhere else.
            log.warn('[KBIngest] refused: privacy screen unavailable:', /** @type {Error} */ (e).message);
            return { error: 'The personal-data check could not run, so nothing was stored.' };
        }
        if (screened.outcome === OUTCOME.SKIPPED) {
            // Nothing written, nothing destroyed. execKnowledgeWrite turns this
            // into an amber skip carrying the reason.
            log.warn('[KBIngest] refused by the privacy shield', JSON.stringify({ kbId: knowledgeBaseId, reason: screened.reason }));
            return { error: screened.reason || 'Blocked by the personal-data check.' };
        }
        const screenedBody = String(screened.text == null ? body : screened.text);
        const piiFields = { piiStatus: screened.piiStatus, piiCategories: screened.piiCategories };
        const refreshOpts = { origin: originOf(context), pii: piiFields };

        const tenantId = kb.tenant_id || orgId || 'system';
        const source = await _ensureAutomationSource(knowledgeBaseId, context);
        const sourceId = source ? source.id : null;
        const origin = originOf(context);
        const docTitle = title || origin.defaultTitle;
        const threadId = sourceUri ? String(sourceUri).split('/').pop() : null;
        const baseMeta = {
            ingestedBy: 'automation', source_type: origin.sourceType, provider: origin.provider,
            sourceUri: sourceUri || null, threadId, inboxId: context.inboxId || null,
            // The SCREENED text. This metadata copy is what a later merge reads
            // back, so storing the raw body here kept an un-redacted copy of
            // exactly what the shield had removed.
            article: screenedBody,
        };

        // ── 1. Same ticket re-resolved → refresh its own article in place ──
        if (sourceUri) {
            const existing = await findDocumentBySourceUri(knowledgeBaseId, sourceUri);
            if (existing) {
                const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, screenedBody, docTitle, lang, { threadId, inboxId: context.inboxId || null }, sourceId, refreshOpts);
                if (res.status === 'skipped') return { error: res.error || 'The document could not be stored.' };
                return { ok: true, refreshed: true, deduped: false, documentId: res.document.id, chunks_created: res.chunks, sourceUri };
            }
        }

        // ── 2. New article with dedup (content_hash + simhash) ──
        try {
            const res = await ingestDocument(tenantId, knowledgeBaseId, screenedBody, docTitle, origin.sourceType, sourceUri || null, {
                skipDedup: !dedupe, lang: lang || 'auto', metadata: baseMeta,
                sourceId, externalId: sourceUri || null, createdBy: context.userId || null,
                // Screened above; `privacy: null` so it is not screened twice.
                // The verdict travels as the two pii_* columns instead.
                privacy: null, ...piiFields,
            });
            /**
             * `ingestDocument` REPORTS a refusal, it does not throw: an
             * unstorable document comes back as {status:'skipped', chunks:0}
             * with a content-less row. Reading only `res.document.id` turned
             * that into a green step claiming `written: true` against a
             * document holding nothing. `core/kb/sources/index.js` already
             * checks this; so does this now.
             */
            if (res.status === 'skipped') {
                return { error: res.error || 'The document could not be stored.' };
            }
            return { ok: true, deduped: false, documentId: res.document.id, chunks_created: res.chunks, sourceUri: sourceUri || null };
        } catch (e) {
            return await resolveIngestConflict(e, {
                tenantId, knowledgeBaseId, body: screenedBody, docTitle, lang, sourceUri, baseMeta, sourceId,
                context, threadId, piiFields, refreshOpts, origin, orgId, nearDuplicateStrategy,
            });
        }
    } catch (e) {
        log.error('[kbIngestTools] ingest failed:', /** @type {Error} */ (e).message);
        return { error: /** @type {Error} */ (e).message };
    }
}

/**
 * @typedef {{ tenantId: string, knowledgeBaseId: string, body: string, docTitle: string, lang?: string, sourceUri?: string,
 *   baseMeta: Record<string, unknown>, sourceId: string | null, context: KbIngestContext, threadId: string | null,
 *   piiFields: PiiFields, refreshOpts: { origin: KbOrigin, pii: PiiFields }, origin: KbOrigin, orgId: string | null,
 *   nearDuplicateStrategy: string }} IngestJob  what the near-duplicate resolution needs of the write in progress
 * @typedef {{ piiStatus?: string, piiCategories?: string[] }} PiiFields
 * @typedef {Error & { code?: string, documentId?: string }} IngestConflict  what ingestDocument throws on a duplicate
 */

/**
 * A refused new article: an exact duplicate adds nothing (the canonical document covers it), a
 * near-duplicate of a DIFFERENT ticket is resolved per strategy, anything else is rethrown.
 * @param {IngestConflict} e
 * @param {IngestJob} job
 */
async function resolveIngestConflict(e, job) {
    const { sourceUri } = job;
    if (e.code === 'DUPLICATE') {
        return { ok: true, deduped: true, reason: 'content_hash_dup', documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
    }
    if (e.code === 'NEAR_DUPLICATE') return resolveNearDuplicate(e, job);
    throw e;
}

/**
 * A near-duplicate of a DIFFERENT ticket: 'add' stores it as its own document, 'skip' (or no
 * readable existing one) keeps the existing, 'replace' overwrites it, 'merge' combines the two.
 * @param {IngestConflict} e
 * @param {IngestJob} job
 */
async function resolveNearDuplicate(e, job) {
    const { nearDuplicateStrategy, sourceUri } = job;
    const existing = e.documentId ? await knowledgeBases.getDocument(e.documentId).catch((e) => fallbackSwallowed('integrations/kbIngestTools:executeKbIngestTool', e, null)) : null;

    // 'add': a near-duplicate of a DIFFERENT subject is stored as
    // its own document. The exact-duplicate branch still
    // dedupes, so this never stores a byte-identical copy.
    if (nearDuplicateStrategy === 'add') return storeNearDuplicateCopy(e, job);
    if (nearDuplicateStrategy === 'skip' || !existing) {
        return { ok: true, deduped: true, reason: 'simhash_near_dup', nearDuplicateOf: e.documentId, documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
    }
    if (nearDuplicateStrategy === 'replace') return replaceNearDuplicate(e, existing, job);
    return mergeNearDuplicate(e, existing, job);
}

/** The 'add' strategy: the article stored as its own document, without dedup.
 * @param {IngestConflict} e
 * @param {IngestJob} job
 */
async function storeNearDuplicateCopy(e, job) {
    const { tenantId, knowledgeBaseId, body, docTitle, origin, sourceUri, lang, baseMeta, sourceId, context, piiFields } = job;
    const res = await ingestDocument(tenantId, knowledgeBaseId, body, docTitle, origin.sourceType, sourceUri || null, {
        skipDedup: true, lang: lang || 'auto', metadata: baseMeta,
        sourceId, externalId: sourceUri || null, createdBy: context.userId || null,
        privacy: null, ...piiFields,
    });
    if (res.status === 'skipped') return { error: res.error || 'The document could not be stored.' };
    return { ok: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, chunks_created: res.chunks, sourceUri: sourceUri || null };
}

/**
 * 'replace' (and 'merge' without stored article text): the existing document refreshed in place.
 * @param {IngestConflict} e
 * @param {KbDocumentRow} existing
 * @param {IngestJob} job
 */
async function replaceNearDuplicate(e, existing, job) {
    const { tenantId, knowledgeBaseId, body, docTitle, lang, threadId, context, sourceUri, sourceId, refreshOpts } = job;
    const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, body, docTitle, lang, { threadId, inboxId: context.inboxId || null, replacedBy: sourceUri || null }, sourceId, refreshOpts);
    return { ok: true, replaced: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, chunks_created: res.chunks, sourceUri: sourceUri || null };
}

/**
 * 'merge': prior and new article combined, refreshed in place with every source it now covers.
 * @param {IngestConflict} e
 * @param {KbDocumentRow} existing
 * @param {IngestJob} job
 */
async function mergeNearDuplicate(e, existing, job) {
    const { tenantId, knowledgeBaseId, body, docTitle, lang, sourceUri, sourceId, refreshOpts, orgId } = job;
    const prevMeta = _readMetadata(existing);
    const priorArticle = (prevMeta.article && String(prevMeta.article).trim()) || null;
    // Pre-change doc without stored article text → replace with latest.
    if (!priorArticle) return replaceNearDuplicate(e, existing, job);
    const merged = await _mergeArticles(priorArticle, body, orgId);
    if (!merged) {
        // Merge LLM failed → keep the existing article unchanged.
        return { ok: true, deduped: true, reason: 'merge_failed_kept_existing', nearDuplicateOf: e.documentId, documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
    }
    const mergedSources = Array.from(new Set([
        ...(Array.isArray(prevMeta.mergedSources) ? prevMeta.mergedSources : (existing.source_uri ? [existing.source_uri] : [])),
        sourceUri || null,
    ].filter(Boolean)));
    const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, merged, docTitle, lang, { mergedSources }, sourceId, refreshOpts);
    return { ok: true, merged: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, mergedSources, chunks_created: res.chunks, sourceUri: sourceUri || null };
}

module.exports = { KB_INGEST_TOOLS, isKbIngestTool, executeKbIngestTool, ORIGINS };

/**
 * Who runs this action: the automation runner / tool dispatcher context.
 * @typedef {{ orgId?: string | null, userId?: string | null, automationId?: string | null, automationTitle?: string,
 *   inboxId?: string | null, origin?: string }} KbIngestContext
 * @typedef {typeof ORIGINS.support} KbOrigin
 * A `documents` row (stores/kb/documentQueries.js has no row typedef).
 * @typedef {Record<string, any>} KbDocumentRow
 */
