// @typecheck noImplicitAny
'use strict';
/**
 * The test-bench assistant: what leaves the server, and what comes back.
 *
 * ── What leaves ────────────────────────────────────────────────────────────
 * The assistant is an ordinary model call, OUTSIDE the Privacy Shield. What
 * it may see is fixed by the feature decision: the type's name, the admin's
 * description, and keyed look-alikes of the examples (mask.js). Nothing else.
 *
 *   buildOutbound       turns the admin's input into exactly that: examples
 *                       are masked, and every real example in the name or
 *                       description is replaced by its look-alike
 *                       (case-insensitive). The preview route returns this
 *                       object as-is, so the admin sees the payload itself.
 *   buildAssistMessages receives ONLY { name, description, lookalikes,
 *                       method }. There is no context object it could reach
 *                       into, so a field added to a type next year cannot
 *                       join the payload by itself (the BFSF-441 rule).
 *   checkOutbound       scans that payload once more, for personal data
 *                       (the guard) and for the org's own words and patterns
 *                       (the Node matcher), and fails CLOSED: a finding is a
 *                       422 for the admin to fix, an unreadable check is a 503.
 *
 * ── What comes back ────────────────────────────────────────────────────────
 * The model's answer is untrusted. sanitizeAssistOutput keeps a template only
 * when it contains an exact look-alike, swaps REAL examples in (round-robin, so
 * every example gets a sentence), and computes the gold offsets itself on the
 * swapped text. Near misses that mention an example are dropped, patterns must
 * validate and match every real example, labels must look like labels. Every
 * drop is counted, never explained with the dropped text.
 */

const crypto = require('node:crypto');
const { maskExamples, acceptedKeepFixed, proposeKeepFixed } = require('./mask');
const { fullMatchAll, describePattern } = require('./patternTools');
const { buildAllowMatcher, filterAllowedEntities } = require('../../dlp/allowTerms');
const { METHODS, MAX_TEMPLATES, MAX_NEAR_MISSES, MAX_PATTERNS, MAX_LABELS, MAX_TEXT, MAX_GOLD, LABEL_RX, cpLength, containsExample, scrubText, ASSIST_OPTIONS, SYSTEM_PROMPT, unavailable, clean } = require('./assistScrubText');

// ── Outbound ────────────────────────────────────────────────────────────────

/**
 * What the assistant would see for this input.
 * @param {{ type?: { id?: string, method?: string, name?: string, description?: string } | null, examples?: unknown,
 *   keepFixed?: unknown, key: Buffer, orgId?: string | null }} input
 * @returns {{ outbound: { name: string, description: string, lookalikes: string[] },
 *             pairs: Array<{ example: string, lookalike: string }>,
 *             keepFixed: string[], keepFixedProposal: string[] }}
 */
function buildOutbound({ type, examples, keepFixed, key, orgId }) {
    const method = type?.method;
    const list = (Array.isArray(examples) ? examples : []).filter((e) => typeof e === 'string' && e);
    const keep = acceptedKeepFixed(keepFixed, list, method);
    const pairs = maskExamples(list, { key, orgId, typeId: type?.id, keepFixed: keep })
        .filter((p) => p.lookalike);
    const lookalikeOf = new Map(pairs.map((p) => [p.example, p.lookalike]));
    return {
        outbound: {
            name: scrubText(type?.name, list, lookalikeOf),
            description: scrubText(type?.description, list, lookalikeOf),
            lookalikes: pairs.map((p) => p.lookalike),
        },
        pairs,
        keepFixed: keep,
        keepFixedProposal: proposeKeepFixed(list, method),
    };
}

// ── The model call ──────────────────────────────────────────────────────────

const ASSIST_TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'propose_test_data',
        description: 'Propose test sentences, near misses, patterns and labels for one kind of data.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['suggested_method', 'templates', 'near_misses', 'patterns', 'ai_labels'],
            properties: {
                suggested_method: {
                    type: 'string',
                    enum: [...METHODS],
                    description: 'words: a fixed list of names or terms. pattern: a fixed format. ai: names with no list and no fixed format.',
                },
                templates: {
                    type: 'array', maxItems: MAX_TEMPLATES, items: { type: 'string' },
                    description: 'Realistic sentences that each contain at least one example value, copied exactly.',
                },
                near_misses: {
                    type: 'array', maxItems: MAX_NEAR_MISSES, items: { type: 'string' },
                    description: 'Similar sentences that contain nothing of this kind and none of the example values.',
                },
                patterns: {
                    type: 'array', maxItems: MAX_PATTERNS, items: { type: 'string' },
                    description: 'Regular expressions (RE2 syntax) that match each example value completely. Empty when there is no fixed format.',
                },
                ai_labels: {
                    type: 'array', maxItems: MAX_LABELS, items: { type: 'string' },
                    description: 'Short noun phrases naming this kind of data for an entity recognition model.',
                },
            },
        },
    },
});

/**
 * The whole payload that leaves for the provider. It is built from these four
 * values and nothing else, by construction.
 * @param {{ name?: string, description?: string, lookalikes?: string[], method?: string }} input
 */
function buildAssistMessages({ name, description, lookalikes, method }) {
    const values = (Array.isArray(lookalikes) ? lookalikes : []).map((v) => String(v));
    const user = [
        '<kind_of_data>',
        `Name: ${String(name || '')}`,
        `Description: ${String(description || '')}`,
        `Recognition method chosen so far: ${METHODS.includes(method) ? method : 'not chosen'}`,
        '</kind_of_data>',
        '<example_values>',
        ...values,
        '</example_values>',
    ].join('\n');
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

// ── The personal-data check on the outbound payload ─────────────────────────

/**
 * @typedef {{ partial?: boolean, timedOut?: unknown[], failed?: unknown[], spans?: Array<{ start: number, end: number, typeId: string }> }} MatchNodeResult
 */

/**
 * Scan the outbound name and description for personal data (the guard) and
 * for the org's own words and pattern types (the Node matcher production
 * uses). Findings carry offsets into the OUTBOUND text, which is what the
 * preview shows. Fails closed: no guard, a degraded scan or a timed-out
 * matcher is a 503, never "nothing found".
 *
 * The org's "Never hide these" list and the well-known-companies switch apply
 * to the guard's findings, exactly as they do in chat: a description such as
 * "project names used at Philips" would otherwise be refused for naming a
 * company the shield itself lets through. Matches of the org's own types are
 * never allowed away (filterAllowedEntities keeps `cdt_` categories).
 *
 * @param {{
 *   outbound?: { name?: string, description?: string },
 *   detectPii: (text: string, a: null, b: undefined, opts: { priority: string }) => Promise<{ degraded?: boolean, guardAbsent?: boolean, entities?: Array<{ offset?: number, length?: number, category?: string }> }>,
 *   engine: {
 *     compileTypes: (types: object[]) => unknown,
 *     matchNode: (text: string, compiled: unknown) => MatchNodeResult | Promise<MatchNodeResult>,
 *   },
 *   orgTypes?: Array<{ method?: string, status?: string }>,
 *   allowConfig?: { piiAllowTerms?: string[], piiAllowPublicOrgs?: boolean },
 * }} params
 * @returns {Promise<Array<{ field: 'name'|'description', start: number, end: number, category: string }>>}
 */
async function checkOutbound({ outbound, detectPii, engine, orgTypes, allowConfig = {} }) {
    const allow = buildAllowMatcher(allowConfig || {});
    const local = (Array.isArray(orgTypes) ? orgTypes : [])
        .filter((t) => t && (t.method === 'words' || t.method === 'pattern') && t.status !== 'invalid');
    let compiled = null;
    if (local.length) {
        try { compiled = await engine.compileTypes(local); } catch (_) { throw unavailable(); }
    }
    /** @type {Array<{ field: 'name'|'description', start: number, end: number, category: string }>} */
    const findings = [];
    for (const field of /** @type {Array<'name' | 'description'>} */ (['name', 'description'])) {
        const text = outbound?.[field];
        if (!text) continue;
        /** @type {Awaited<ReturnType<typeof detectPii>>} */
        let scan;
        try { scan = await detectPii(text, null, undefined, { priority: 'bulk' }); } catch (_) { throw unavailable(); }
        if (!scan || scan.degraded || scan.guardAbsent) throw unavailable();
        for (const e of filterAllowedEntities(scan.entities || [], allow).entities) {
            if (!Number.isFinite(e?.offset) || !Number.isFinite(e?.length)) continue;
            findings.push({ field, start: e.offset, end: e.offset + e.length, category: String(e.category || 'pii') });
        }
        if (compiled) {
            let m;
            try { m = await engine.matchNode(text, compiled); } catch (_) { throw unavailable(); }
            // A matcher that timed out, stopped early or failed on a stored
            // type has not checked the text: that is not "nothing found".
            if (!m || m.partial || (Array.isArray(m.timedOut) && m.timedOut.length)
                || (Array.isArray(m.failed) && m.failed.length)) throw unavailable();
            for (const s of m.spans || []) findings.push({ field, start: s.start, end: s.end, category: String(s.typeId) });
        }
    }
    return findings.sort((a, b) => (a.field === b.field ? a.start - b.start : a.field === 'name' ? -1 : 1));
}

// ── What comes back ─────────────────────────────────────────────────────────

const cleanPattern = (/** @type {unknown} */ s) => (typeof s === 'string' ? s.replace(/\p{Cc}+/gu, '').trim() : '');
const listOf = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : []);
const defaultId = () => `s_${crypto.randomBytes(5).toString('hex')}`;

/**
 * Non-overlapping exact (case-sensitive) look-alike occurrences, longest first at each position.
 * @param {string} text
 * @param {string[]} lookalikes
 */
function lookalikeOccurrences(text, lookalikes) {
    const ordered = [...lookalikes].sort((a, b) => b.length - a.length);
    const out = [];
    let i = 0;
    while (i < text.length) {
        const hit = ordered.find((l) => l && text.startsWith(l, i));
        if (hit) { out.push({ start: i, end: i + hit.length }); i += hit.length; } else i += 1;
    }
    return out;
}

/**
 * @param {string} text
 * @param {string[]} values
 */
function mentionsAny(text, values) {
    const low = text.toLowerCase();
    return values.some((v) => v && (cpLength(v) >= 3 ? low.includes(v.toLowerCase()) : containsExample(text, v)));
}

/**
 * Clean the model's answer. PURE apart from `validatePattern` (async, the
 * engine's check) and the id generator.
 *
 * @param {any} structured  chatForcedTool's `structured`
 * @param {{ pairs: Array<{example: string, lookalike: string}>, examples?: string[],
 *           validatePattern: (source: string) => Promise<{ok: boolean}>,
 *           caseSensitive?: boolean, newId?: () => string }} ctx
 * @typedef {{ id: string, text: string, gold: Array<{ start: number, end: number }>, origin: string }} AssistSentence
 * @typedef {{ suggestedMethod: string | null, sentences: AssistSentence[], nearMisses: AssistSentence[],
 *   candidates: { patterns: Array<{ source: string, describe?: string }>, aiLabels: string[] },
 *   dropped: { sentences: number, patterns: number, labels: number } }} AssistResult
 * @returns {Promise<null | AssistResult>}
 */
async function sanitizeAssistOutput(structured, { pairs, examples, validatePattern, caseSensitive = true, newId = defaultId }) {
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return null;
    const usablePairs = listOf(pairs).filter((p) => p && p.example && p.lookalike);
    const lookalikes = usablePairs.map((p) => p.lookalike);
    const swapIn = usablePairs.map((p) => p.example);
    const realExamples = [...new Set([...swapIn, ...listOf(examples)].filter((e) => typeof e === 'string' && e))];
    const dropped = { sentences: 0, patterns: 0, labels: 0 };

    // Templates → sentences with real examples and server-side gold.
    const sentences = [];
    const seenText = new Set();
    const seenTemplates = new Set();
    let cursor = 0;
    for (const raw of listOf(structured.templates)) {
        const template = clean(raw);
        const occ = template && swapIn.length ? lookalikeOccurrences(template, lookalikes) : [];
        if (sentences.length >= MAX_TEMPLATES || occ.length === 0 || occ.length > MAX_GOLD || seenTemplates.has(template)) {
            dropped.sentences += 1;
            continue;
        }
        seenTemplates.add(template);
        let text = '';
        let last = 0;
        /** @type {Array<{ start: number, end: number }>} */
        const gold = [];
        occ.forEach((o, k) => {
            const example = swapIn[(cursor + k) % swapIn.length];
            text += template.slice(last, o.start);
            gold.push({ start: text.length, end: text.length + example.length });
            text += example;
            last = o.end;
        });
        text += template.slice(last);
        if (text.length > MAX_TEXT || seenText.has(text)) { dropped.sentences += 1; continue; }
        cursor += occ.length;
        seenText.add(text);
        sentences.push({ id: newId(), text, gold, origin: 'assistant' });
    }

    // Near misses: nothing in them may be one of our values, look-alike or real.
    const nearMisses = [];
    for (const raw of listOf(structured.near_misses)) {
        const text = clean(raw);
        if (!text || nearMisses.length >= MAX_NEAR_MISSES || seenText.has(text)
            || mentionsAny(text, lookalikes) || mentionsAny(text, realExamples)) {
            dropped.sentences += 1;
            continue;
        }
        seenText.add(text);
        nearMisses.push({ id: newId(), text, gold: [], origin: 'nearmiss' });
    }

    // Patterns: safe (local rules + the engine) and a complete match of every real example.
    /** @type {Array<{ source: string, describe?: string }>} */
    const patterns = [];
    for (const raw of listOf(structured.patterns)) {
        const source = cleanPattern(raw);
        if (!source || patterns.length >= MAX_PATTERNS || patterns.some((p) => p.source === source)) { dropped.patterns += 1; continue; }
        const verdict = await validatePattern(source);
        if (!verdict?.ok || !fullMatchAll(source, realExamples, { caseSensitive })) { dropped.patterns += 1; continue; }
        const words = describePattern(source);
        patterns.push(words ? { source, describe: words } : { source });
    }

    // Labels for the model: label-shaped, never a value of ours, distinct.
    const aiLabels = [];
    const seenLabels = new Set();
    for (const raw of listOf(structured.ai_labels)) {
        const label = clean(raw);
        const key = label.toLowerCase();
        if (!LABEL_RX.test(label) || aiLabels.length >= MAX_LABELS || seenLabels.has(key)
            || mentionsAny(label, lookalikes) || mentionsAny(label, realExamples)) {
            dropped.labels += 1;
            continue;
        }
        seenLabels.add(key);
        aiLabels.push(label);
    }

    const suggestedMethod = METHODS.includes(structured.suggested_method) ? structured.suggested_method : null;
    return { suggestedMethod, sentences, nearMisses, candidates: { patterns, aiLabels }, dropped };
}

/**
 * Did the cleaned answer leave anything to show?
 * @param {AssistResult | null} result
 */
function hasUsableOutput(result) {
    return !!result && (result.sentences.length + result.nearMisses.length
        + result.candidates.patterns.length + result.candidates.aiLabels.length) > 0;
}

module.exports = {
    ASSIST_TOOL,
    ASSIST_OPTIONS,
    LABEL_RX,
    buildOutbound,
    scrubText,
    buildAssistMessages,
    checkOutbound,
    sanitizeAssistOutput,
    hasUsableOutput,
};
