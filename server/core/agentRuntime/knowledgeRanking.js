/**
 * The ranking half of the agent knowledge search (./knowledgeSearch): score
 * floors, near-duplicate removal, the per-passage trim, and the prompt block
 * the surviving passages are injected as.
 */
const configStore = require('../../stores/configStore');
const { estimateTokens, fitIntoTokenBudget } = require('../llm/tokenBudget');
const log = require('../../telemetry/log');

// Rough budget for knowledge injection. Exposed as env vars so we can tune
// per model-family without a code change. The EMAIL_KB_* names are the
// pre-rename spelling of the same knobs — an operator who tuned those must
// not silently fall back to the defaults on upgrade.
const PER_CHUNK_TOKEN_CAP = parseInt(
    process.env.KB_PER_CHUNK_TOKENS || process.env.EMAIL_KB_PER_CHUNK_TOKENS || '800', 10);
const GLOBAL_INJECT_TOKEN_CAP = parseInt(
    process.env.KB_INJECT_TOKENS || process.env.EMAIL_KB_INJECT_TOKENS || '4000', 10);

/** Word tokens of a passage for near-duplicate comparison, heading breadcrumb lines stripped. */
function contentTokenSet(text) {
    if (!text) return new Set();
    const body = text.replace(/^#{1,6}\s+.+$/gm, '').trim();
    return new Set(body.toLowerCase().split(/\s+/).filter(t => t.length > 2));
}

function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    let intersection = 0;
    for (const t of setA) { if (setB.has(t)) intersection++; }
    return intersection / (setA.size + setB.size - intersection);
}

/**
 * Whether the scores are CALIBRATED 0-1 (Azure Cohere or the GPU sidecar).
 *
 * DO NOT add the llama.cpp reranker (`llamacpp_rerank_enabled`) to this
 * check, however much it looks like an oversight. Calibration is what lets
 * the 0.72 floor be meaningful. Cohere's scores are; a sigmoid over
 * bge-reranker-v2-m3's logits is NOT. Measured on one Dutch corpus, the
 * correct passage ranked #1 for all five phrasings of the same question while
 * its absolute score ranged from 0.04 to 0.9997 — "hoe vaak inspecteren"
 * scored it 0.296 and "inspectie" 0.045. Turning this flag on for llama.cpp
 * would apply the 0.72 floor and throw the right answer away for two of
 * those five queries.
 *
 * Leaving it false keeps the floor at 0.01, which suits sigmoid scores well:
 * it still drops the unrelated passages (they come back at 0.000) without
 * pretending the score is a probability. Its RANKING is trustworthy; its
 * absolute value is not.
 */
async function hasCalibratedReranker() {
    const azureRerankerEndpoint = await configStore.getConfig('azure_reranker_endpoint') || process.env.AZURE_RERANKER_ENDPOINT;
    return !!(azureRerankerEndpoint || process.env.RERANKER_URL);
}

/**
 * Filter, sort and dedupe the retrieved results. Resolves to
 * `{ filtered, topResults, hasReranker }`: everything that passed the score
 * floors (sorted), and the passages that will be shown.
 */
async function rankKnowledgeResults(results) {
    // Score threshold: use config-based detection (same logic as kbSearchTools.js)
    // When Azure reranker is configured, no threshold — trust the reranker.
    // When RRF-only, apply a minimal floor.
    const hasReranker = await hasCalibratedReranker();
    const MIN_SCORE = hasReranker ? 0 : 0.01;
    let filtered = results.filter(r => (r.score || 0) >= MIN_SCORE);

    // Keep individual chunks as separate results (do NOT merge by source —
    // merging then truncating was hiding most of the content from the model).
    // Sort by score, take top results for the system prompt.
    filtered.sort((a, b) => (b.score || 0) - (a.score || 0));

    // ── Minimum relevance floor ──────────────────────────────────
    // When a reranker is active, scores are calibrated 0-1 → apply the floor.
    // Without reranker, scores are RRF fusion values (typically 0.01-0.03) →
    // skip this filter (the MIN_SCORE check above already handles the floor).
    if (hasReranker) {
        const MIN_SCORE_THRESHOLD = 0.72;
        const beforeCount = filtered.length;
        filtered = filtered.filter(r => (r.score || 0) >= MIN_SCORE_THRESHOLD);
        if (beforeCount !== filtered.length) {
            log.info(`[KnowledgeSearch] Relevance filter: ${beforeCount} → ${filtered.length} chunks (threshold: ${MIN_SCORE_THRESHOLD})`);
        }
    }

    return { filtered, topResults: dedupeNearDuplicates(filtered), hasReranker };
}

/**
 * Near-duplicate deduplication. Chunks with overlapping content (from
 * sliding-window overlap or similar table structures) can flood the top-K.
 * Remove chunks whose content is >85% similar (Jaccard on word tokens) to a
 * higher-scoring chunk already in the list.
 */
function dedupeNearDuplicates(sorted) {
    const deduped = [];
    const dedupedTokenSets = [];
    const SIMILARITY_THRESHOLD = 0.85;
    const TOP_K_DEFAULT = 3;       // Show at least top 3
    const TOP_K_MAX = 10;          // Never exceed 10
    const HIGH_SCORE_THRESHOLD = 0.80; // Include all chunks scoring ≥ 80%
    for (const result of sorted) {
        const tokens = contentTokenSet(result.content);
        let isDuplicate = false;
        for (const existing of dedupedTokenSets) {
            if (jaccardSimilarity(tokens, existing) >= SIMILARITY_THRESHOLD) {
                isDuplicate = true;
                break;
            }
        }
        if (!isDuplicate) {
            const score = result.score || 0;
            // Stop collecting once we've hit the default AND this chunk is below threshold
            if (deduped.length >= TOP_K_DEFAULT && score < HIGH_SCORE_THRESHOLD) break;
            deduped.push(result);
            dedupedTokenSets.push(tokens);
        }
        if (deduped.length >= TOP_K_MAX) break;
    }
    return deduped;
}

/**
 * Per-chunk content cap (token-aware) + strip repeated heading breadcrumbs,
 * in place. Returns whether any chunk was truncated.
 */
function trimPassages(topResults) {
    const seenDocHeadings = new Map();
    let anyChunkTruncated = false;
    for (const result of topResults) {
        // Strip heading lines already seen from the same source document
        const docKey = result.metadata?.source || 'unknown';
        const seen = seenDocHeadings.get(docKey);
        if (seen && result.content) {
            result.content = result.content.split('\n').filter(line => {
                if (/^#{1,6}\s+/.test(line) && seen.has(line.trim())) return false;
                return true;
            }).join('\n').replace(/^\n+/, '');
        }
        const headings = (result.content || '').match(/^#{1,6}\s+.+$/gm) || [];
        if (!seen) {
            seenDocHeadings.set(docKey, new Set(headings.map(h => h.trim())));
        } else {
            headings.forEach(h => seen.add(h.trim()));
        }
        if (result.content) {
            const fit = fitIntoTokenBudget(result.content, PER_CHUNK_TOKEN_CAP);
            result.content = fit.text;
            if (fit.truncated) anyChunkTruncated = true;
        }
    }
    return anyChunkTruncated;
}

/** The label each passage is shown under in the prompt. */
function passageSource(k) {
    const meta = k.metadata || {};
    let source = meta.source || meta.source_uri || 'Unknown Source';
    if (meta.type === 'url_import' && meta.source) source = meta.source;
    return source;
}

/** The system-prompt block for the passages found (`labels` from the shield strip, when it ran). */
function knowledgePromptBlock({ topResults, labels, includeRefs, isStrictKnowledge, anyChunkTruncated }) {
    let knowledgeText = topResults.map((k, i) => {
        const source = Array.isArray(labels) ? labels[i] : passageSource(k);
        return `### Source ${i + 1}: ${source}\n${k.content}\n`;
    }).join('\n');

    // Global cap: protect against the combined knowledge block blowing
    // the context window even when individual chunks already fit.
    const fitGlobal = fitIntoTokenBudget(knowledgeText, GLOBAL_INJECT_TOKEN_CAP);
    knowledgeText = fitGlobal.text;
    const truncationNote = (fitGlobal.truncated || anyChunkTruncated)
        ? '\nSome retrieved sources were truncated to fit the context window.'
        : '';
    log.info(`[KnowledgeSearch] Inject tokens: ~${estimateTokens(knowledgeText)} (cap ${GLOBAL_INJECT_TOKEN_CAP}, chunkCap ${PER_CHUNK_TOKEN_CAP}, truncated=${fitGlobal.truncated || anyChunkTruncated})`);

    const citationInstruction = includeRefs
        ? 'Do NOT include inline citations or source references (e.g. [Source 1] or "(Bron: ...)") in your response text. Source references are shown separately below your answer.'
        : 'Do NOT include citations (e.g. [Source 1]) or source references in your final response.';

    if (isStrictKnowledge) {
        return `\n\n## KNOWLEDGE BASE RESULTS
The following information was retrieved from your knowledge base. Answer ONLY from this data.
If the user's question cannot be answered from the information below, you MUST say you don't have that information.
${citationInstruction}${truncationNote}

${knowledgeText}
`;
    }
    return `\n\n## RELEVANT KNOWLEDGE BASE
The following information from your knowledge base was retrieved based on the user's request.
Use this information to answer the question.
${citationInstruction}${truncationNote}

${knowledgeText}
`;
}

/** Strict-knowledge mode with nothing to show: the "say you don't know" block. */
const NO_RESULTS_BLOCK = `\n\n## KNOWLEDGE BASE RESULTS
No relevant information was found in your knowledge base for this query.
You MUST tell the user you don't have information about this topic. Do NOT answer from general knowledge.
Suggest the user rephrase their question or ask about topics covered in your knowledge base.
`;

/** Strict-knowledge mode with no knowledge base attached at all. */
const EMPTY_KB_BLOCK = `\n\n## KNOWLEDGE BASE RESULTS
Your knowledge base is empty. No information has been added yet.
You MUST tell the user that your knowledge base has not been set up yet and you cannot answer questions until knowledge is added.
Do NOT answer any questions from general knowledge.
`;

module.exports = {
    contentTokenSet, jaccardSimilarity, hasCalibratedReranker, rankKnowledgeResults,
    trimPassages, passageSource, knowledgePromptBlock, NO_RESULTS_BLOCK, EMPTY_KB_BLOCK,
};
