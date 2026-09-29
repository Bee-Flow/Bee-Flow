'use strict';
/**
 * The test bench's matching: the SAME matchers production runs, applied to a
 * draft type and a list of test sentences.
 *
 *   words / pattern  engine.compileTypes + engine.matchNode, the Node matcher
 *                    the shield itself uses (core/privacy/customTypes). A
 *                    bench result that differs from production would be a lie
 *                    about what gets hidden, so nothing here re-implements it.
 *   ai               engine.probeGuard: the guard's raw candidates at its
 *                    query floor (0.10), for the draft's prompt TOGETHER with
 *                    the org's other ai prompts, because production sends the
 *                    whole ai group in one pass and the labels compete for the
 *                    same words. The per-type floors and the flat overlap
 *                    decode (highest score wins a contested span) are applied
 *                    here, which is what lets /tune sweep floors locally
 *                    without asking the guard again.
 */

const { HttpError, badRequest } = require('../../http/errors');
const { scoreSentence, summarize } = require('./scoring');

const PROBE_BATCH = 8;
const MAX_GROUP_LABELS = 6;
const TOKEN_KEY_RX = /^[a-z](?:[a-z0-9_]{0,30}[a-z])?$/;
const IDENTITY_FIELDS = ['id', 'name', 'description', 'method', 'tokenKey', 'origin', 'legacy', 'createdAt', 'createdBy', 'updatedAt'];
const BENCH_IDENTITY = Object.freeze({ name: 'Test bench', tokenKey: 'bench_test', description: '' });

const listOf = (v) => (Array.isArray(v) ? v : []);

function draftErrorFor(errors) {
    const list = listOf(errors);
    const patternError = list.find((e) => String(e?.field || '').startsWith('pattern'));
    if (patternError) {
        return new HttpError(422, 'pattern_unsafe',
            'This pattern cannot be used: it is too long, does not compile, can match nothing at all or could take too long to run.',
            { reason: String(patternError.code || 'pattern_invalid') });
    }
    const first = list[0];
    return badRequest('invalid_request', first?.message || 'This type cannot be tested as it is.',
        list.map((e) => ({ path: `body.type.${e?.field || ''}`, message: String(e?.message || ''), code: e?.code })));
}

/**
 * The draft as the engine sees it: its identity fields and ONLY the block of
 * its own method (quality and status are display state, not behaviour).
 * Validated by the engine. When only identity fields are wrong (an unfinished
 * name, a placeholder that collides), the bench borrows a neutral identity:
 * it tests the method block, not the name.
 */
async function normaliseDraft(engine, draft, { orgId, orgTypes }) {
    const base = {};
    for (const k of IDENTITY_FIELDS) if (draft?.[k] !== undefined) base[k] = draft[k];
    if (draft?.method && draft[draft.method] !== undefined) base[draft.method] = draft[draft.method];
    let verdict = await engine.validateTypeSpec(base, { orgId, existingTypes: listOf(orgTypes) });
    if (verdict?.ok) return verdict.normalized || base;
    const errors = listOf(verdict?.errors);
    const fieldsInError = [...new Set(errors.map((e) => String(e?.field || '').split(/[.[]/)[0]))];
    if (errors.length && fieldsInError.every((f) => Object.hasOwn(BENCH_IDENTITY, f))) {
        const neutral = { ...base };
        for (const f of fieldsInError) neutral[f] = BENCH_IDENTITY[f];
        // Stored types still vouch for a migrated type's `legacy` flag.
        verdict = await engine.validateTypeSpec(neutral, { orgId, existingTypes: [], storedTypes: listOf(orgTypes) });
        if (verdict?.ok) return verdict.normalized || neutral;
    }
    throw draftErrorFor(listOf(verdict?.errors).length ? verdict.errors : errors);
}

function compiledIsInvalid(compiled, id) {
    return listOf(compiled?.invalid).some((x) => x === id || x?.id === id);
}

/**
 * Words / pattern: spans per text for this spec, via the production matcher.
 * @returns {Promise<{ spans: Array<Array<{start:number,end:number}>>, degraded: boolean }>}
 */
async function predictLocal(engine, spec, texts) {
    const compiled = await engine.compileTypes([spec]);
    if (compiledIsInvalid(compiled, spec.id)) {
        const entry = listOf(compiled?.invalid).find((x) => x?.id === spec.id);
        throw draftErrorFor([{ field: spec.method === 'pattern' ? 'pattern.source' : spec.method, code: entry?.reason || entry?.code || 'invalid', message: entry?.message }]);
    }
    const spans = [];
    let degraded = false;
    for (const text of texts) {
        const m = await engine.matchNode(text, compiled);
        if (m?.partial || listOf(m?.timedOut).includes(spec.id) || listOf(m?.failed).includes(spec.id)) degraded = true;
        spans.push(listOf(m?.spans).filter((s) => s.typeId === spec.id).map((s) => ({ start: s.start, end: s.end })));
    }
    return { spans, degraded };
}

/** The org's OTHER enforced ai types, as production groups them (the draft takes one slot). */
function otherAiTypes(orgTypes, draftId, draftPrompt) {
    const taken = String(draftPrompt || '').trim().toLowerCase();
    return listOf(orgTypes)
        .filter((t) => t && t.method === 'ai' && t.id !== draftId && t.status !== 'invalid'
            && typeof t.ai?.prompt === 'string' && Number.isFinite(t.ai?.floor)
            && t.ai.prompt.trim().toLowerCase() !== taken)
        .slice(0, MAX_GROUP_LABELS - 1)
        .map((t) => ({ id: t.id, prompt: t.ai.prompt, floor: t.ai.floor }));
}

/**
 * All raw candidates for `texts` under one label set, in batches the guard
 * accepts. Any failure that is not already a client-facing error is the
 * guard being unavailable.
 */
async function probeAll(engine, texts, labelSet) {
    const out = [];
    for (let at = 0; at < texts.length; at += PROBE_BATCH) {
        const chunk = texts.slice(at, at + PROBE_BATCH);
        let res;
        try {
            res = await engine.probeGuard(chunk, labelSet, { priority: 'bulk' });
        } catch (err) {
            if (err instanceof HttpError) throw err;
            throw new HttpError(503, 'guard_unavailable', 'The AI recognition service is not available right now. Try again later.');
        }
        for (const c of listOf(res?.candidates)) {
            if (!Number.isInteger(c?.text_idx) || c.text_idx < 0 || c.text_idx >= chunk.length) continue;
            if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start || !Number.isFinite(c.score)) continue;
            out.push({ textIdx: at + c.text_idx, label: String(c.label), start: c.start, end: c.end, score: c.score });
        }
    }
    return out;
}

/**
 * Apply per-label floors, then the flat decode: highest score first, a span
 * that overlaps an accepted one is dropped. Returns the target label's spans
 * per text.
 */
function decodeAi(candidates, floors, targetId, textCount) {
    const byText = Array.from({ length: textCount }, () => []);
    for (const c of candidates) {
        const floor = floors[c.label];
        if (floor === undefined || c.score < floor) continue;
        byText[c.textIdx].push(c);
    }
    return byText.map((list) => {
        const accepted = [];
        for (const c of [...list].sort((a, b) => b.score - a.score || a.start - b.start)) {
            if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue;
            accepted.push(c);
        }
        return accepted.filter((c) => c.label === targetId)
            .map((c) => ({ start: c.start, end: c.end }))
            .sort((a, b) => a.start - b.start);
    });
}

/** The ai group for a draft prompt: its label set and floors. */
function aiGroup(spec, prompt, floor, orgTypes) {
    const others = otherAiTypes(orgTypes, spec.id, prompt);
    const labelSet = { [spec.id]: prompt };
    const floors = { [spec.id]: floor };
    for (const o of others) { labelSet[o.id] = o.prompt; floors[o.id] = o.floor; }
    return { labelSet, floors };
}

/** Score predicted spans against every sentence. */
function scoreAll(sentences, spansPerText) {
    const scored = sentences.map((s, i) => scoreSentence(s, spansPerText[i] || []));
    return { scored, summary: summarize(scored) };
}

/** "[project_code_1] was moved to [project_code_2]": one number per distinct value. */
function placeholderText(text, spans, tokenKey) {
    const key = TOKEN_KEY_RX.test(String(tokenKey || '')) ? tokenKey : 'data';
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const numbers = new Map();
    let out = '';
    let last = 0;
    for (const s of sorted) {
        if (s.start < last) continue;
        const value = text.slice(s.start, s.end);
        if (!numbers.has(value)) numbers.set(value, numbers.size + 1);
        out += `${text.slice(last, s.start)}[${key}_${numbers.get(value)}]`;
        last = s.end;
    }
    return out + text.slice(last);
}

/**
 * POST /test: score the draft on the sentences.
 * @returns {Promise<{ results, summary, preview?, engine: 'local'|'guard', degraded?: true }>}
 */
async function runTest({ engine, spec, sentences, orgTypes, tokenKey }) {
    const texts = sentences.map((s) => s.text);
    let spans;
    let engineName;
    let degraded = false;
    if (spec.method === 'ai') {
        const { labelSet, floors } = aiGroup(spec, spec.ai.prompt, spec.ai.floor, orgTypes);
        spans = decodeAi(await probeAll(engine, texts, labelSet), floors, spec.id, texts.length);
        engineName = 'guard';
    } else {
        ({ spans, degraded } = await predictLocal(engine, spec, texts));
        engineName = 'local';
    }
    const { scored, summary } = scoreAll(sentences, spans);
    const out = {
        results: sentences.map((s, i) => ({ id: s.id, marks: scored[i].marks, verdict: scored[i].verdict })),
        summary,
        engine: engineName,
    };
    if (sentences.length === 1) out.preview = placeholderText(texts[0], spans[0] || [], tokenKey || spec.tokenKey);
    if (degraded) out.degraded = true;
    return out;
}

module.exports = {
    PROBE_BATCH,
    normaliseDraft,
    predictLocal,
    otherAiTypes,
    probeAll,
    decodeAi,
    aiGroup,
    scoreAll,
    placeholderText,
    runTest,
};
