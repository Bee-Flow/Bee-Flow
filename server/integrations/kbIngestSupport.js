// @typecheck strict
/**
 * Knowledge Base Ingest — the parts of the knowledge_base_ingest tool that
 * need nothing of the write in progress (kbIngestTools.js runs the tool): its
 * definition, the target-base check, the article merge the 'merge'
 * near-duplicate strategy runs, and the metadata reader.
 */

'use strict';

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

/**
 * @param {string} name
 */
function isKbIngestTool(name) {
    return name === 'knowledge_base_ingest';
}

/**
 * Merge a prior article with a freshly-distilled one into a single, richer,
 * deduplicated article (DEFAULT_MERGE_PROMPT on a 'fast'-tier model).
 * @param {string} priorArticle
 * @param {string} incomingArticle
 * @param {string | null} orgId
 */
async function mergeArticles(priorArticle, incomingArticle, orgId) {
    const { createChatCompletion } = require('../agents/providerAdapters');
    const { DEFAULT_MERGE_PROMPT } = require('../core/text/emailTextUtils');
    const { resolveModelForTierName } = require('../core/llm/modelResolver');
    // With a fallback the resolver always names a model.
    const model = /** @type {string} */ (await resolveModelForTierName('fast', { userOrgId: orgId || null, fallback: 'gpt-4.1-mini' }));
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
 * documents.metadata may arrive as a JSON string or an object — normalise.
 * @param {{ metadata?: string | Record<string, unknown> | null } | null | undefined} doc
 * @returns {Record<string, unknown>}
 */
function readMetadata(doc) {
    const m = doc && doc.metadata;
    if (!m) return {};
    if (typeof m === 'string') { try { return JSON.parse(m) || {}; } catch { return {}; } }
    return m;
}

/**
 * Why this write may not reach the base (missing, system, another org's — tenant isolation), else null.
 * @param {{ tenant_id?: string, organization_id?: string | null } | null} kb  the knowledge base row
 * @param {string | null} orgId
 * @returns {{ error: string } | null}
 */
function targetRefusal(kb, orgId) {
    if (!kb) return { error: 'Knowledge base not found.' };
    if (kb.tenant_id === 'system') return { error: 'Cannot ingest into a system knowledge base.' };
    if (kb.organization_id && orgId && kb.organization_id !== orgId) {
        return { error: 'Knowledge base does not belong to this organisation.' };
    }
    if (kb.organization_id && !orgId) {
        return { error: 'No organisation context for ingestion.' };
    }
    return null;
}

module.exports = { KB_INGEST_TOOLS, isKbIngestTool, targetRefusal, mergeArticles, readMetadata };
