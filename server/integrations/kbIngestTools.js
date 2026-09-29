/**
 * Knowledge Base Ingest — a ROUTINE-ONLY automation action (never exposed to
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

const SOURCE_TYPE = 'support_ticket';

/**
 * Where a write came from — it decides how the document is FILED, not whether
 * it is allowed.
 *
 * This tool was built for one caller (a resolved support ticket, distilled),
 * so `support_ticket` / `provider: support` were constants. K10 gave every
 * routine a `knowledge_write` step that comes through the same door, and a
 * nightly system summary filed as a support ticket is wrong in the Sources
 * list, wrong in the document's metadata, and wrong to anyone later asking
 * where a paragraph came from.
 *
 * `support` stays the DEFAULT so the existing callers are unchanged.
 */
const ORIGINS = Object.freeze({
    support: { sourceType: SOURCE_TYPE, provider: 'support', defaultTitle: 'Support article' },
    routine: { sourceType: 'routine_write', provider: 'automation', defaultTitle: 'Untitled' },
});
function originOf(context) { return ORIGINS[context && context.origin] || ORIGINS.support; }

const KB_INGEST_TOOLS = [{
    type: 'function',
    function: {
        name: 'knowledge_base_ingest',
        description: 'Ingest a distilled article into an organisation knowledge base. Chunks, embeds and stores the content. Dedupes on exact content_hash AND simhash near-duplicate detection. Re-ingesting the same sourceUri refreshes the article in place; a near-duplicate of a different ticket is merged/skipped/replaced per nearDuplicateStrategy. Writes only to a KB owned by the running organisation.',
        parameters: {
            type: 'object',
            properties: {
                knowledgeBaseId: { type: 'string', description: 'Target knowledge base UUID (must belong to this organisation).' },
                title: { type: 'string', description: 'Short article title.' },
                content: { type: 'string', description: 'Markdown article body to ingest.' },
                sourceUri: { type: 'string', description: "Provenance link, e.g. 'support://ticket/<id>'. Re-ingesting the same sourceUri refreshes the prior article in place." },
                lang: { type: 'string', description: "Language hint or 'auto' (default)." },
                dedupe: { type: 'boolean', description: 'Run content_hash + simhash dedup against other articles (default true). Set false to force a new document.' },
                nearDuplicateStrategy: { type: 'string', enum: ['merge', 'skip', 'replace', 'add'], description: "What to do when a near-duplicate of a DIFFERENT ticket already exists: 'merge' (combine into one richer article — default for support), 'skip' (keep the existing one), 'replace' (overwrite with the new one), 'add' (store it anyway as its own document). Re-ingesting the SAME sourceUri always refreshes that document in place, whichever of these is set." },
            },
            required: ['knowledgeBaseId', 'content'],
        },
    },
}];

function isKbIngestTool(name) {
    return name === 'knowledge_base_ingest';
}

/** documents.metadata may arrive as a JSON string or an object — normalise. */
function _readMetadata(doc) {
    const m = doc && doc.metadata;
    if (!m) return {};
    if (typeof m === 'string') { try { return JSON.parse(m) || {}; } catch { return {}; } }
    return m;
}

/**
 * The kb_sources row this action's documents hang off: one `automation` source
 * per routine when the runner tells us which routine is running, otherwise one
 * shared "Automation ingest" source per KB.
 *
 * Never throws — the source is bookkeeping, the article is the product.
 */
async function _ensureAutomationSource(kbId, context = {}) {
    const { ensureKbSource } = require('../core/kb/sources/ensureSource');
    const automationId = context.automationId || null;
    const origin = originOf(context);
    return ensureKbSource(kbId, 'automation', {
        // The routine's own title when the caller knows it: "Automation
        // 4f2c-…" in the Sources list tells a person nothing about what keeps
        // adding documents to their knowledge base.
        name: context.automationTitle || (automationId ? `Automation ${automationId}` : 'Automation ingest'),
        config: { provider: origin.provider, sourceType: origin.sourceType, ...(automationId ? { automationId } : {}) },
        // Matched on the routine id where there is one, so re-titling a
        // routine updates its source rather than creating a second.
        configMatch: automationId ? { automationId } : { sourceType: origin.sourceType },
        createdBy: context.userId || null,
    });
}

/**
 * Merge a prior article with a freshly-distilled one into a single, richer,
 * deduplicated article (DEFAULT_MERGE_PROMPT on a 'fast'-tier model).
 */
async function _mergeArticles(priorArticle, incomingArticle, orgId) {
    const { createChatCompletion } = require('../agents/providerAdapters');
    const { DEFAULT_MERGE_PROMPT } = require('../core/text/emailTextUtils');
    const { resolveModelForTierName } = require('../core/llm/modelResolver');
    const model = await resolveModelForTierName('fast', { userOrgId: orgId || null, fallback: 'gpt-4.1-mini' });
    const res = await createChatCompletion({
        model,
        messages: [
            { role: 'system', content: DEFAULT_MERGE_PROMPT },
            { role: 'user', content: `${priorArticle}\n\n---\n\n${incomingArticle}` },
        ],
        temperature: 0.2,
        max_tokens: 4000,
    });
    const merged = res?.choices?.[0]?.message?.content?.trim();
    return merged && merged.length >= 20 ? merged : null;
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
 * The MORE travelled of the two ingest paths, not the less: a routine with a
 * sourceUri comes through here on every run after the first.
 *
 * It DELETES BEFORE IT INGESTS, and with `skipSnapshot`, so there is no version
 * to restore from. That is only safe while nothing in between can refuse: the
 * privacy screen therefore runs in `executeKbIngestTool` BEFORE this is
 * entered, and `opts.pii` carries its verdict here rather than a policy this
 * function would have to apply itself.
 */
async function _refreshInPlace(tenantId, kbId, existingDoc, article, title, lang, extraMeta = {}, sourceId = null, opts = {}) {
    const origin = opts.origin || ORIGINS.support;
    const canonicalUri = existingDoc.source_uri || null;
    const prevMeta = _readMetadata(existingDoc);
    // skipSnapshot: this row is being replaced by its own source, not deleted
    // by a person — a snapshot per refresh would copy the full article into
    // kb_document_versions, a table with no erasure path.
    await deleteDocumentChunks(kbId, existingDoc.id, tenantId, { skipSnapshot: true }).catch(() => {});
    const metadata = {
        ingestedBy: 'routine',
        sourceUri: canonicalUri,
        ...prevMeta,
        // AFTER prevMeta, deliberately. Spreading the old metadata over the new
        // origin put the previous run's `support_ticket` straight back, so a
        // routine's article kept being re-filed as a support ticket on every
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
        if (!kb) return { error: 'Knowledge base not found.' };
        if (kb.tenant_id === 'system') return { error: 'Cannot ingest into a system knowledge base.' };
        // Tenant isolation: never write into another org's KB.
        if (kb.organization_id && orgId && kb.organization_id !== orgId) {
            return { error: 'Knowledge base does not belong to this organisation.' };
        }
        if (kb.organization_id && !orgId) {
            return { error: 'No organisation context for ingestion.' };
        }

        /**
         * ── WHO IS WRITING, checked at RUN TIME (K10) ────────────────
         * The organisation test above was the only gate, and it is not one: it
         * let ANY author of ANY routine in an organisation write documents
         * into ANY of that organisation's knowledge bases — including one
         * shared with a group they are not in, and one they have no
         * `manage_knowledge` right over. A routine is a program somebody else
         * may run, so that was a write nobody reviewed reaching a base nobody
         * agreed to.
         *
         * Re-checked HERE, not only where the routine was saved, and keyed on
         * the identity this run actually has. A routine is saved once and runs
         * for months: the author's rights can be taken away, the base's
         * sharing can narrow, and the definition itself is data an import or
         * an MCP patch can put an id into. A stored definition is a record of
         * what somebody asked for, never evidence that it was allowed.
         *
         * `context.userId` is the routine's OWNER — the identity a run has
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
         * door to every routine: a `knowledge_write` step can be pointed
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
         * The screen used to be handed DOWN to ingestDocument, on both paths.
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
            log.warn('[KBIngest] refused: privacy screen unavailable:', e.message);
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
            ingestedBy: 'routine', source_type: origin.sourceType, provider: origin.provider,
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
            // Exact duplicate → nothing new to add; the canonical doc covers it.
            if (e.code === 'DUPLICATE') {
                return { ok: true, deduped: true, reason: 'content_hash_dup', documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
            }
            // Near-duplicate of a DIFFERENT ticket → resolve per strategy.
            if (e.code === 'NEAR_DUPLICATE') {
                const existing = e.documentId ? await knowledgeBases.getDocument(e.documentId).catch(() => null) : null;

                // 'add': a near-duplicate of a DIFFERENT subject is stored as
                // its own document. The exact-duplicate branch above still
                // dedupes, so this never stores a byte-identical copy.
                if (nearDuplicateStrategy === 'add') {
                    const res = await ingestDocument(tenantId, knowledgeBaseId, screenedBody, docTitle, origin.sourceType, sourceUri || null, {
                        skipDedup: true, lang: lang || 'auto', metadata: baseMeta,
                        sourceId, externalId: sourceUri || null, createdBy: context.userId || null,
                        privacy: null, ...piiFields,
                    });
                    if (res.status === 'skipped') return { error: res.error || 'The document could not be stored.' };
                    return { ok: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, chunks_created: res.chunks, sourceUri: sourceUri || null };
                }
                if (nearDuplicateStrategy === 'skip' || !existing) {
                    return { ok: true, deduped: true, reason: 'simhash_near_dup', nearDuplicateOf: e.documentId, documentId: e.documentId, chunks_created: 0, sourceUri: sourceUri || null };
                }

                if (nearDuplicateStrategy === 'replace') {
                    const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, screenedBody, docTitle, lang, { threadId, inboxId: context.inboxId || null, replacedBy: sourceUri || null }, sourceId, refreshOpts);
                    return { ok: true, replaced: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, chunks_created: res.chunks, sourceUri: sourceUri || null };
                }

                // 'merge' — combine prior + new into one richer article.
                const prevMeta = _readMetadata(existing);
                const priorArticle = (prevMeta.article && String(prevMeta.article).trim()) || null;
                if (!priorArticle) {
                    // Pre-change doc without stored article text → replace with latest.
                    const res = await _refreshInPlace(tenantId, knowledgeBaseId, existing, screenedBody, docTitle, lang, { threadId, inboxId: context.inboxId || null, replacedBy: sourceUri || null }, sourceId, refreshOpts);
                    return { ok: true, replaced: true, deduped: false, documentId: res.document.id, nearDuplicateOf: e.documentId, chunks_created: res.chunks, sourceUri: sourceUri || null };
                }
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
            throw e;
        }
    } catch (e) {
        log.error('[kbIngestTools] ingest failed:', e.message);
        return { error: e.message };
    }
}

module.exports = { KB_INGEST_TOOLS, isKbIngestTool, executeKbIngestTool, ORIGINS };
