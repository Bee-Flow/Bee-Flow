// @typecheck strict
/**
 * Knowledge Base Search — the pure steps around a kb_search retrieval
 * (executeKbSearchTool, kbSearchTools.js): the small-talk guard before it, and
 * after it the score cut, near-duplicate dedupe, repeated-heading strip and the
 * per-chunk section label. Nothing here does I/O.
 */

'use strict';

/**
 * @typedef {{ id?: string | number, chunk_id?: string | number, document_id?: unknown, score?: number, rerank_score?: number,
 *   title?: string, source_uri?: string, content?: string, [k: string]: unknown }} KbChunk  one retrieved chunk
 * @typedef {{ id?: string | number, document_id?: unknown, rerank_score?: number, source_uri?: string,
 *   chunk_id: string | number | null, result_number: number, title: string, source_url: string | null,
 *   content?: string, score: number, [k: string]: unknown }} KbResult  a chunk past the score cut, numbered and titled
 */

const GREETING_WORDS = /\b(h(i|oi|ey|ello|allo|ee)|dag|goeie(morgen|middag|avond)?|yo|sup|thanks?|thankyou|thank\s*you|dank(je|jewel|u)?|bedankt|doei|bye|tot\s*ziens|how\s*are\s*you|hoe\s*gaat\s*het|welkom|welcome)\b/i;

/**
 * Greeting / small-talk guard. The LLM sometimes calls the tool with greetings
 * like "servicedesk assistent welkom hi", which wastes embedding + reranker API
 * calls. Filler words (agent names, "assistent", etc.) are stripped, and when
 * what remains is just a greeting the stripped query is returned; null means
 * search.
 * @param {string} query
 * @returns {string | null}
 */
function smallTalkCore(query) {
    const queryCore = query.trim()
        .replace(/\b(assistent|assistant|servicedesk|service\s*desk|helpdesk|agent|bot)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (GREETING_WORDS.test(queryCore) && queryCore.split(/\s+/).filter(w => w.length >= 2).length <= 3) return queryCore;
    return null;
}

/**
 * The chunks at or above the score threshold, numbered and with the ids that
 * let a citation open and kb_fetch resolve the passage (kb_chunks.chunk_id is
 * an ordinal within the document; kb_fetch looks up the row `id`).
 * @param {KbChunk[]} chunks
 * @param {number} scoreThreshold
 * @returns {KbResult[]}
 */
function scoredResults(chunks, scoreThreshold) {
    return chunks
        .filter(c => (c.score || c.rerank_score || 0) >= scoreThreshold)
        .map((c, i) => ({
            ...c,
            chunk_id: c.id ?? c.chunk_id ?? null,
            result_number: i + 1,
            title: c.title || c.source_uri || 'Knowledge Base',
            source_url: c.source_uri || null,
            content: c.content,
            score: Math.round((c.score || c.rerank_score || 0) * 1000) / 1000,
        }));
}

/**
 * The words of a chunk's body (headings left out), lowercased, longer than two.
 * @param {string | undefined} text
 * @returns {Set<string>}
 */
function getTokenSet(text) {
    if (!text) return new Set();
    const body = text.replace(/^#{1,6}\s+.+$/gm, '').trim();
    return new Set(body.toLowerCase().split(/\s+/).filter(t => t.length > 2));
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
function jaccard(a, b) {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const t of a) { if (b.has(t)) inter++; }
    return inter / (a.size + b.size - inter);
}

/**
 * Near-duplicate deduplication (Jaccard on word tokens, 0.85): the first of
 * each group of near-identical results is kept, in order.
 * @param {KbResult[]} results
 * @returns {KbResult[]}
 */
function dedupeNearDuplicates(results) {
    const dedupResults = [];
    /** @type {Set<string>[]} */
    const dedupSets = [];
    for (const r of results) {
        const ts = getTokenSet(r.content);
        if (!dedupSets.some(ex => jaccard(ts, ex) >= 0.85)) {
            dedupResults.push(r);
            dedupSets.push(ts);
        }
    }
    return dedupResults;
}

/**
 * Strip repeated heading breadcrumbs: when several chunks come from the same
 * document their parent heading lines repeat, so a later chunk loses the ones
 * an earlier chunk of that document already carried. Each content is then
 * capped at maxChars. Rewrites `content` in place.
 * @param {KbResult[]} results
 * @param {number} maxChars
 */
function stripRepeatedHeadings(results, maxChars) {
    /** @type {Map<string, Set<string>>} */
    const seenDocHeadings = new Map(); // title → Set of heading lines already sent
    for (const r of results) {
        const docKey = r.title || 'unknown';
        const seen = seenDocHeadings.get(docKey);
        if (seen && r.content) {
            r.content = r.content.split('\n').filter(line => {
                if (/^#{1,6}\s+/.test(line) && seen.has(line.trim())) return false;
                return true;
            }).join('\n').replace(/^\n+/, '');
        }
        // Record headings from this chunk
        const headings = (r.content || '').match(/^#{1,6}\s+.+$/gm) || [];
        if (!seen) {
            seenDocHeadings.set(docKey, new Set(headings.map(h => h.trim())));
        } else {
            headings.forEach(h => seen.add(h.trim()));
        }
        if (r.content && r.content.length > maxChars) {
            r.content = r.content.slice(0, maxChars) + '…';
        }
    }
}

/**
 * Each result with its section label: the deepest heading and a short snippet
 * of the body, either alone, or "Chunk <n>" when the chunk has neither.
 * @param {KbResult[]} results
 * @returns {Array<{ r: KbResult, sectionLabel: string }>}
 */
function labelSections(results) {
    return results.map((r, i) => {
        const headings = (r.content || '').match(/^#{1,6}\s+(.+)$/gm) || [];
        const deepest = headings.length > 0 ? headings[headings.length - 1].replace(/^#{1,6}\s+/, '').trim() : null;
        const body = (r.content || '').replace(/^#{1,6}\s+.+$/gm, '').replace(/^\|.*$/gm, '').trim();
        const snippet = body.split(/[.!?\n]/).filter(s => s.trim().length > 10)[0]?.trim() || '';
        const sectionLabel = deepest
            ? (snippet ? `${deepest} — ${snippet.slice(0, 60)}` : deepest)
            : (snippet ? snippet.slice(0, 80) : `Chunk ${i + 1}`);
        return { r, sectionLabel };
    });
}

module.exports = { smallTalkCore, scoredResults, dedupeNearDuplicates, stripRepeatedHeadings, labelSections };
