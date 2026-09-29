// @typecheck
/**
 * "What the AI took from it" — one line per document (Knowledge artboard 1b).
 *
 * ── WHY A COLUMN OF PROSE BEATS A COLUMN OF FILENAMES ───────────────
 * A source's document table is a list of names somebody else chose:
 * `Offerte Van Dijk 2026-0398.docx`, `scan_0034.jpg`. Names are how the
 * uploader thinks about files, not what the knowledge base learned from them.
 * The one question this screen exists to answer — "is the right thing in
 * here?" — is answerable from "Betaaltermijn, geldigheid 30 dagen, garantie"
 * and not from the filename above it.
 *
 * ── IT MUST NEVER THROW, AND NEVER BLOCK ────────────────────────────
 * This runs inside the ingest of every document, on a model call that can be
 * slow, rate-limited, misconfigured or simply absent on a self-hosted install
 * with no provider set up. A summary is a nicety; the document is the point.
 * So every failure path returns null and the row is stored without one — the
 * `supportClassifier.classifyInbound` shape, for the same reason.
 *
 * ── ON THE FAST TIER, ON A PREFIX ───────────────────────────────────
 * Six thousand characters is enough for a summary of what a document is
 * ABOUT, and a 400-page PDF summarised in full would cost more than the
 * embedding did. The fast tier because this is a label, not an answer.
 *
 * ── AND IT SEES WHAT THE KNOWLEDGE BASE SEES ────────────────────────
 * It is handed the text AFTER `ingestPrivacy` has run, so a redacted document
 * is summarised from `[person_1] agreed…`. Summarising the original would put
 * the personal data straight back on screen in the column next to the shield
 * icon that says it was removed.
 */

/** Characters of the document the summary is allowed to look at. */
const log = require('../../telemetry/log');
const PREFIX_CHARS = 6000;
/** A label is not worth waiting on. */
const TIMEOUT_MS = 20_000;
/** The artboard's line is one short sentence; the model is told so. */
const MAX_SUMMARY_CHARS = 120;

const TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'record_extract_summary',
        description: 'Record what this document contains, for a one-line label in a document list.',
        parameters: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description: `What this document is about, as a fragment of at most ${MAX_SUMMARY_CHARS} characters. No leading "This document…" — just the subjects, e.g. "Payment terms, 30-day validity, warranty, cancellation".`,
                },
                topics: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Up to five short topic labels.',
                },
            },
            required: ['summary'],
        },
    },
});

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * Summarise one document.
 *
 * @param {object} p
 * @param {string} p.text        the text as STORED (post-shield, see header)
 * @param {string} [p.title]
 * @param {string} [p.language]  the org's language, so the label matches the UI
 * @param {object} [p.deps]      injection seam for the tests
 * @returns {Promise<{summary: string, topics: string[]}|null>} null on ANY
 *          failure — no provider, no model, a timeout, a refusal, a malformed
 *          tool call. The caller stores the document either way.
 */
async function summarise({ text, title = '', language = 'English', deps = {} } = /** @type {any} */ ({})) {
    const body = String(text || '').trim();
    if (body.length < 40) return null; // nothing to say about a line of text

    try {
        const llmClient = deps.llmClient || require('../llm/llmClient');
        const resolveAgentModel = deps.resolveAgentModel
            || require('../agentRuntime').resolveAgentModel;
        const getAIConfig = deps.getAIConfig || require('../aiAgent').getAIConfig;

        const prefix = body.slice(0, PREFIX_CHARS);
        const modelId = await resolveAgentModel('tier:fast', prefix, await getAIConfig());
        if (!modelId) return null;

        const result = await withTimeout(
            llmClient.chatForcedTool(modelId, [
                {
                    role: 'system',
                    content: [
                        'You label documents for a searchable knowledge base.',
                        `Answer in ${language}.`,
                        `Say what the document is ABOUT in at most ${MAX_SUMMARY_CHARS} characters — the subjects it covers, comma-separated, as a fragment rather than a sentence.`,
                        'Do not summarise the content itself, do not quote it, and never repeat names, addresses, account numbers or other personal details you find in it.',
                        'Placeholders like [person_1] are redactions; do not comment on them.',
                    ].join(' '),
                },
                {
                    role: 'user',
                    content: `Title: ${title || '(untitled)'}\n\n${prefix}`,
                },
            ], TOOL, { maxTokens: 300, temperature: 0 }),
            TIMEOUT_MS,
            'extract summary',
        );

        return normalise(result?.structured);
    } catch (e) {
        // Deliberately quiet at warn level: on an install with no provider
        // configured this would otherwise fire once per document, for ever.
        log.warn('[KB] extract summary unavailable:', e.message);
        return null;
    }
}

/**
 * A tool call is model output, so treat it as untrusted: the length cap, the
 * type checks and the topic ceiling are all enforced here rather than hoped
 * for from the schema. A 4000-character "summary" in a 1.2fr table column
 * would break the row it sits in.
 */
function normalise(structured) {
    if (!structured || typeof structured !== 'object') return null;
    const summary = typeof structured.summary === 'string' ? structured.summary.trim() : '';
    if (!summary) return null;
    const topics = Array.isArray(structured.topics)
        ? structured.topics.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 60)).slice(0, 5)
        : [];
    return { summary: summary.slice(0, MAX_SUMMARY_CHARS), topics };
}

/**
 * "…· overlaps with <source>" — the artboard's own annotation for a
 * cross-source near-duplicate.
 *
 * A price list can legitimately arrive as a spreadsheet AND as a table, and
 * K1 annotates rather than refuses that. The annotation belongs on the
 * summary line because that is where somebody looking at two rows that seem
 * to say the same thing will be looking.
 */
function withOverlap(summary, overlapSourceName) {
    const base = (summary || '').trim();
    if (!overlapSourceName) return base || null;
    const note = `overlaps with ${overlapSourceName}`;
    return base ? `${base} · ${note}` : note;
}

module.exports = { summarise, normalise, withOverlap, PREFIX_CHARS, TIMEOUT_MS, MAX_SUMMARY_CHARS, TOOL };
