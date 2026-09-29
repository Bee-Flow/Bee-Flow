// @typecheck
'use strict';
/**
 * The matcher for `words` and `pattern` types. ONE function, used by the
 * production scan (scan.js, through detectPii) and by the test bench, so what
 * the bench shows an admin is what the shield will do.
 *
 * Synchronous on purpose: RE2 and Aho-Corasick are linear, and the only
 * non-linear engine (a migrated V8 pattern) runs in a worker with a hard
 * budget (legacyRunner.js).
 *
 * Returns spans, not entities: the caller decides labels and merging.
 */

const { compileTypes, isCompiled, isWordChar, codePointAt, codePointBefore } = require('./compile');
const { runLegacySync, DEFAULT_BUDGET_MS } = require('./legacyRunner');

// Linear engines can take the whole text; this only bounds a pathological
// multi-megabyte input. Beyond it the ids are reported partial, never
// silently clean.
const NODE_MAX_CHARS = 1_000_000;
// The old custom-terms scanner's bound (MAX_SCAN_CHARS), kept for the V8
// patterns it used to run.
const LEGACY_MAX_CHARS = 100_000;
// A one-letter word without whole-word matching in a big paste is a million
// spans; past this the id is reported partial rather than exhausting memory.
const MAX_SPANS_PER_TYPE = 20_000;

/**
 * @param {string} text
 * @param {any} compiledOrTypes  a compileTypes() result, or an array of types
 * @param {{ legacyBudgetMs?: number }} [opts]
 * @returns {{ spans: Array<{start:number,end:number,typeId:string}>, partial: boolean,
 *             partialIds: string[], timedOut: string[], failed: string[] }}
 */
function matchNode(text, compiledOrTypes, opts = {}) {
    const compiled = isCompiled(compiledOrTypes) ? compiledOrTypes : compileTypes(compiledOrTypes);
    const str = typeof text === 'string' ? text : '';
    const scan = str.length > NODE_MAX_CHARS ? str.slice(0, NODE_MAX_CHARS) : str;
    const spans = [];
    const partialIds = new Set();
    const timedOut = [];
    const failed = compiled.invalid.filter(i => i.reason === 'compile_failed').map(i => i.id);
    /** @type {Map<string, number>} */
    const counts = new Map();

    const push = (start, end, id) => {
        if (!(end > start)) return;
        const n = counts.get(id) || 0;
        if (n >= MAX_SPANS_PER_TYPE) { partialIds.add(id); return; }
        counts.set(id, n + 1);
        spans.push({ start, end, typeId: id });
    };

    const onWord = (start, end, p) => {
        if (p.wholeWord) {
            if (p.edgeStart && isWordChar(codePointBefore(scan, start))) return;
            if (p.edgeEnd && isWordChar(codePointAt(scan, end))) return;
        }
        push(start, end, p.id);
    };
    if (compiled.words.cs) compiled.words.cs.search(scan, false, onWord);
    if (compiled.words.ci) compiled.words.ci.search(scan, true, onWord);

    for (const { id, re } of compiled.patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(scan)) !== null) {
            if (m[0].length === 0) {
                // Step over one whole code point, never into half a pair.
                const cp = scan.codePointAt(m.index);
                re.lastIndex = m.index + (cp !== undefined && cp > 0xFFFF ? 2 : 1);
                if (re.lastIndex > scan.length) break;
                continue;
            }
            push(m.index, m.index + m[0].length, id);
            if ((counts.get(id) || 0) >= MAX_SPANS_PER_TYPE) { partialIds.add(id); break; }
        }
    }

    if (compiled.legacy.length) {
        const legacyText = scan.length > LEGACY_MAX_CHARS ? scan.slice(0, LEGACY_MAX_CHARS) : scan;
        if (legacyText.length < scan.length) compiled.legacy.forEach(j => partialIds.add(j.id));
        const r = runLegacySync(compiled.legacy, legacyText, opts.legacyBudgetMs || DEFAULT_BUDGET_MS);
        for (const [id, list] of r.results) for (const s of list) push(s.start, s.end, id);
        for (const id of r.capped) partialIds.add(id);
        timedOut.push(...r.timedOut);
        failed.push(...r.failed);
    }

    if (scan.length < str.length) {
        for (const id of compiled.types.keys()) {
            const t = compiled.types.get(id);
            if (t.method === 'words' || t.method === 'pattern') partialIds.add(id);
        }
    }

    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    return { spans, partial: partialIds.size > 0, partialIds: [...partialIds], timedOut, failed };
}

module.exports = { matchNode, NODE_MAX_CHARS, LEGACY_MAX_CHARS, MAX_SPANS_PER_TYPE };
