// @typecheck
'use strict';
/**
 * The pattern scan, end to end: collect → template → mine → score → suppress
 * → map → name. An async generator, so the route streams each step as it
 * happens and owns nothing but the wire.
 *
 *   for await (const { event, data } of runPatternScan(input)) …
 *
 * Yields, in order:
 *   phase {phase:'collecting'}, source_step {…} per source,
 *   phase {phase:'templating'}, phase {phase:'mining'}, stats {events, templates, candidates},
 *   phase {phase:'naming'}, suggestion {suggestion} per pattern,
 *   result {suggestions, summary, reason, usage}   (the route's `done`, minus its framing)
 * and stops without a result when the scan's signal aborts.
 *
 * The model sees the evidence cards only (explain.js). Every number on a
 * suggestion is the miner's. Templates are name-masked in ONE batched guard
 * call over the few patterns that will be shown, before any card is built; a
 * missing guard means the deterministic fallback mask, never raw names.
 *
 * Collaborators come in through `overrides` (lazily loaded otherwise), so a
 * test runs the whole scan on fixtures with no module mocking.
 */

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { depsWith } = require('./depsWith');
const { makeEvents } = require('./events');
const { minePatterns } = require('./miner');
const { estimateMinutes, minutesPerMonth } = require('./effort');
const { scoreCandidate } = require('./score');
const { patternSignature, suppressCandidates } = require('./suppress');
const { toDraft, normaliseApp } = require('./builderMapping');
const { toEvidenceCard } = require('./evidenceCard');
const { maskNames, tokenize } = require('./templating');

const DAY = 86_400_000;
const WINDOW_DAYS = 90;
const MAX_PATTERNS = 6;
const FOCUS_BOOST = 1.5;
const MAX_MINUTES_PER_MONTH = 600;
/** Bee Flow's own sources: always there, never "needs X connected". */
const INTERNAL_APPS = new Set(['beeflow', 'chat', 'documents', 'meetings']);

const LOADERS = {
    collectAll: () => require('./sources').collectAll,
    detectPii: () => require('../../core/privacy/piiDetection').detectPii,
    namePatterns: () => require('./explain').namePatterns,
    getAutomatedToolNames: () => (/** @type {any} */ p) => require('../../stores/integrationActivityStore').getAutomatedToolNames(p),
    getAutomations: () => (/** @type {string} */ userId) => require('../../stores/automationStore').getAutomationsForUser(userId),
    getSuppressedSignatures: () => (/** @type {any} */ p) => require('../../stores/suggestionFeedbackStore').getSuppressedSignatures(p),
    appOfTool: () => (/** @type {string} */ tool) => require('../../core/integrations/integrationToolMap').resolveIntegration(tool)?.integration
        || String(tool).split('_')[0],
};

/** @param {Record<string, any>|null|undefined} overrides */
const depsFor = (overrides) => depsWith(LOADERS, overrides);

const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// ── Cache key ────────────────────────────────────────────────────────────────

/**
 * sha256(userId | mode | sorted sources | focus | UTC day [| zone]). The user
 * is in the key as well as in the row's scope: a key that matched across
 * users would serve one person's scan to another. The viewer's time zone
 * joins the key when there is one (it moves every weekday and hour on a
 * card); without one the key is what it always was.
 * @param {{ userId: string, mode: string, sources?: string[]|null, focus?: string, now?: number, timeZone?: string|null }} p
 */
function scanCacheKey({ userId, mode, sources, focus = '', now = Date.now(), timeZone = null }) {
    const list = uniq((Array.isArray(sources) ? sources : []).map((s) => String(s).trim().toLowerCase().replace(/_/g, '-'))).sort();
    const day = Math.floor(now / DAY);
    const parts = [String(userId), mode, list.join(','), focus, String(day)];
    if (timeZone) parts.push(`tz:${timeZone}`);
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ── Collect: the sources' progress, streamed while they run ──────────────────

/**
 * Bridge collectAll's onProgress callback into the generator: each step is
 * yielded as soon as it happens, then the collected result is returned.
 * @param {Function} collectAll
 * @param {any} ctx
 * @param {AbortSignal|undefined} signal
 */
async function* streamCollect(collectAll, ctx, signal) {
    /** @type {any[]} */
    const queue = [];
    /** @type {(() => void)|null} */
    let wake = null;
    let settled = false;
    let outcome = null;
    let failure = null;
    const nudge = () => { const w = wake; wake = null; if (w) w(); };
    const run = Promise.resolve()
        .then(() => collectAll(ctx, { signal, onProgress: (step) => { queue.push(step); nudge(); } }))
        .then((r) => { outcome = r; }, (err) => { failure = err; })
        .finally(() => { settled = true; nudge(); });
    for (;;) {
        while (queue.length) yield { event: 'source_step', data: queue.shift() };
        if (settled) break;
        await new Promise((resolve) => { wake = /** @type {() => void} */ (resolve); });
    }
    await run;
    if (failure) throw failure;
    return /** @type {{ events: any[], steps: any[], reason: string|null }} */ (outcome || { events: [], steps: [], reason: null });
}

// ── Score, suppress, rank ────────────────────────────────────────────────────

/** Effort, draft, score and signature: everything the server decides. */
function enrich(c, now) {
    const minutes = estimateMinutes(c);
    const draft = toDraft(c);
    const withDraft = { ...c, minutes, draft };
    const { score, reasons } = scoreCandidate(withDraft, { now });
    return { ...withDraft, score, reasons, signature: patternSignature(c) };
}

/**
 * What an automation covers, in the terms suppress.js compares: its trigger
 * kind and the apps its trigger and steps use.
 * @param {any} a automation row
 * @param {(tool: string) => string} appOfTool
 */
function automationShape(a, appOfTool) {
    const def = a?.definition && typeof a.definition === 'object' ? a.definition : {};
    const trig = def.trigger && typeof def.trigger === 'object' ? def.trigger : {};
    const apps = [];
    if (typeof trig.appEvent?.provider === 'string') apps.push(trig.appEvent.provider);
    for (const s of Array.isArray(def.steps) ? def.steps : []) {
        if (typeof s?.tool === 'string' && s.tool) {
            try { apps.push(appOfTool(s.tool)); } catch (_) { /* an unknown tool names no app */ }
        }
    }
    return { title: a?.title, triggerKind: trig.kind || a?.triggerType || null, apps: uniq(apps.map(String)) };
}

/** A store read that fails is "nothing to suppress with", logged, never a failed scan. */
async function softly(what, fn, fallback) {
    try {
        const v = await fn();
        return v ?? fallback;
    } catch (err) {
        log.warn(`[RepeatingWork] ${what} unavailable: ${/** @type {any} */ (err)?.message}`);
        return fallback;
    }
}

/**
 * The user's automations, the tools their automations already run and their
 * feedback, for suppressCandidates.
 * @param {string} userId
 * @param {number} now
 * @param {any} d deps
 * @param {{ tools?: boolean }} [opts]
 */
async function suppressionInputs(userId, now, d, opts = {}) {
    const since = new Date(now - WINDOW_DAYS * DAY);
    const [toolNames, automations, feedback] = await Promise.all([
        opts.tools === false ? [] : softly('automated tools', () => d.getAutomatedToolNames({ userId, since }), []),
        softly('automations', () => d.getAutomations(userId), []),
        softly('feedback', () => d.getSuppressedSignatures({ userId }), []),
    ]);
    return {
        automatedToolNames: new Set((Array.isArray(toolNames) ? toolNames : []).map(String)),
        automations: (Array.isArray(automations) ? automations : []).map((a) => automationShape(a, d.appOfTool)),
        feedback: Array.isArray(feedback) ? feedback : [],
    };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'van', 'voor', 'het', 'een', 'met']);

/** Words of a focus worth matching ("invoices" matches "invoice"). */
function focusTokens(focus) {
    return uniq(String(focus || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .map((w) => (w.length > 3 ? w.replace(/s$/u, '') : w)));
}

/** A candidate the focus names (in its template, apps or actions) ranks higher. */
function matchesFocus(c, words) {
    if (!words.length) return false;
    const hay = [
        ...tokenize(c.template || ''),
        ...(c.apps || []).flatMap((a) => String(a).toLowerCase().split(/[-_]/)),
        ...(c.verbs || []).flatMap((v) => String(v).toLowerCase().split(/[._]/)),
    ];
    return words.some((w) => hay.some((h) => h.startsWith(w)));
}

/** @param {any[]} list @param {string[]} words */
function rank(list, words) {
    return list
        .map((c) => (matchesFocus(c, words) ? { ...c, score: Math.round(c.score * FOCUS_BOOST * 1000) / 1000, focused: true } : c))
        .sort((a, b) => (b.score - a.score) || (b.occurrences - a.occurrences));
}

// ── Candidate → client suggestion ────────────────────────────────────────────

const TRIGGER_KINDS = { schedule: 'schedule', app: 'app_event', manual: 'manual' };
const CONFIDENCE_VALUE = { early: 'low', normal: 'medium', high: 'high' };

function complexityOf(draft) {
    const steps = draft?.steps || [];
    if (steps.some((s) => s.family === 'branch') || steps.length >= 5) return steps.length >= 5 ? 'advanced' : 'orchestrated';
    if (steps.length >= 3) return 'orchestrated';
    if (steps.length === 2 || steps.some((s) => s.family === 'ai')) return 'assisted';
    return 'quick';
}

function frequencyOf(cad) {
    switch (cad?.kind) {
        case 'daily':
        case 'weekdays': return 'daily';
        case 'weekly': return 'weekly';
        case 'biweekly':
        case 'monthly': return 'monthly';
        default: {
            const p = Number(cad?.perMonth) || 0;
            if (p >= 20) return 'daily';
            if (p >= 4) return 'weekly';
            return p >= 1 ? 'monthly' : 'occasional';
        }
    }
}

/**
 * The client's Suggestion: the old fields filled from the miner's numbers, the
 * new `pattern` from the sanitised evidence card. Nothing here comes from the
 * model except the three texts in `name`.
 * @param {any} c enriched candidate (template name-masked)
 * @param {{ title: string, why: string, buildPrompt: string }} name
 * @param {{ now: number, windowDays: number, connected: Set<string> }} ctx
 */
function toSuggestion(c, name, { now, windowDays, connected }) {
    const card = toEvidenceCard(c);
    const apps = uniq((c.apps || []).map(normaliseApp));
    const minutes = c.minutes || estimateMinutes(c);
    const perMonth = Number(c.cadence?.perMonth) || 0;
    const mpm = minutesPerMonth(minutes, perMonth);
    const lastTs = c.cadence?.lastTs ?? (c.timestamps?.length ? Math.max(...c.timestamps) : null);
    const lastUsedDays = lastTs == null ? null : Math.max(0, Math.floor((now - lastTs) / DAY));
    const verbs = Array.isArray(c.verbs) ? c.verbs : [];
    const verbApps = Array.isArray(c.verbApps) && c.verbApps.length === verbs.length ? c.verbApps : verbs.map(() => c.apps?.[0]);
    const score = Number.isFinite(c.score) ? c.score : 0;
    /** @type {Record<string, any>} */
    const cadence = { kind: card.cadence.kind, perMonth: card.perMonth, weeksPresent: card.weeksPresent, weeksWindow: card.weeksWindow };
    if (card.cadence.weekday != null) cadence.weekday = card.cadence.weekday;
    if (card.cadence.hourBand) cadence.hourBand = card.cadence.hourBand;

    return {
        id: `pat_${String(c.signature || patternSignature(c)).slice(0, 12)}`,
        title: name.title,
        description: name.why,
        requiredIntegrations: apps,
        unavailableIntegrations: apps.filter((a) => !INTERNAL_APPS.has(a) && !connected.has(a)),
        triggerKind: TRIGGER_KINDS[card.draft?.trigger?.kind] || 'manual',
        buildPrompt: name.buildPrompt,
        groundedIn: 'activity',
        complexity: complexityOf(card.draft),
        evidence: {
            kind: 'activity',
            signals: verbs.slice(0, 6).map((v, i) => ({
                tool: v, integration: normaliseApp(verbApps[i] || ''), count: card.occurrences, lastUsedDays,
            })),
            summary: `${card.occurrences}× in the last ${windowDays} days`,
        },
        value: {
            score: Math.max(1, Math.min(100, Math.round(100 * (1 - Math.exp(-score / 2))))),
            minutesSavedPerMonth: Math.min(MAX_MINUTES_PER_MONTH, Math.round((mpm[0] + mpm[1]) / 2)),
            frequencyLabel: frequencyOf(c.cadence),
            confidence: CONFIDENCE_VALUE[card.confidence] || 'medium',
        },
        pattern: {
            kind: card.kind,
            signature: String(c.signature || patternSignature(c)),
            cadence,
            occurrences: card.occurrences,
            windowDays,
            distinctDays: card.distinctDays,
            weekdayHistogram: card.weekdayHistogram,
            minutesPerMonth: mpm,
            basis: minutes.basis === 'measured' ? 'measured' : 'heuristic',
            template: card.template,
            apps,
            draft: card.draft,
            reasons: Array.isArray(c.reasons) ? c.reasons.map(String) : [],
            confidence: card.confidence,
        },
    };
}

// ── Suppression of a cached result ───────────────────────────────────────────

/**
 * Re-check a cached patterns result against the user's CURRENT feedback and
 * automations: a pattern snoozed or built since the scan must not come back
 * from the cache. Suggestions without a pattern pass through.
 * @param {any[]} suggestions
 * @param {{ userId: string, now?: number }} p
 * @param {Record<string, any>|null} [overrides]
 */
async function suppressSuggestions(suggestions, { userId, now = Date.now() }, overrides = null) {
    const list = Array.isArray(suggestions) ? suggestions : [];
    const withPattern = list.filter((s) => s?.pattern?.signature);
    if (!withPattern.length) return list;
    const d = depsFor(overrides);
    const inputs = await suppressionInputs(userId, now, d, { tools: false });
    const { kept } = suppressCandidates({
        ...inputs,
        now,
        candidates: withPattern.map((s) => ({
            kind: s.pattern.kind, apps: s.pattern.apps, verbs: [], templateIds: [],
            cadence: { kind: s.pattern.cadence?.kind }, draft: s.pattern.draft, signature: s.pattern.signature, _s: s,
        })),
    });
    const keep = new Set(kept.map((k) => k._s));
    return list.filter((s) => !s?.pattern?.signature || keep.has(s));
}

// ── The scan ─────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   userId: string,
 *   sources?: string[]|null, focus?: string, signal?: AbortSignal,
 *   now?: number, windowDays?: number,
 *   timeZone?: string|null,   // the viewer's IANA zone: weekdays and hours in local time (UTC without one)
 *   availableToolNames?: Iterable<string>, availableIntegrationIds?: Iterable<string>,
 *   executeTool?: (name: string, args: object) => Promise<any>,
 *   nextcloudUid?: string|null,
 *   naming?: { modelId?: string|null, llmClient?: any, guard?: ((messages: any[]) => Promise<any>)|null },
 *   collectors?: Record<string, Function>, sourceDeps?: Record<string, any>, limits?: Record<string, number>,
 *   maxPatterns?: number,
 * }} input
 * @param {Record<string, any>|null} [overrides]
 * @returns {AsyncGenerator<{ event: string, data: any }, void, unknown>}
 */
async function* runPatternScan(input, overrides = null) {
    const d = depsFor(overrides);
    const now = input.now ?? Date.now();
    const windowDays = input.windowDays ?? WINDOW_DAYS;
    const signal = input.signal;
    const pii = new Set();
    const summary = { sources: /** @type {string[]} */ ([]), events: 0, templates: 0, patterns: 0, piiCategories: /** @type {string[]} */ ([]) };
    const result = (suggestions, reason, usage = null) => {
        summary.piiCategories = [...pii].sort();
        return { event: 'result', data: { suggestions, summary, reason, usage } };
    };

    // ── collect ──
    yield { event: 'phase', data: { phase: 'collecting' } };
    const collected = yield* streamCollect(d.collectAll, {
        userId: input.userId, now, windowDays, sources: input.sources,
        availableToolNames: input.availableToolNames, executeTool: input.executeTool,
        nextcloudUid: input.nextcloudUid || null,
        deps: input.sourceDeps, collectors: input.collectors, limits: input.limits,
    }, signal);
    if (signal?.aborted) return;
    const steps = Array.isArray(collected.steps) ? collected.steps : [];
    summary.sources = uniq(steps.filter((s) => s.status === 'done').map((s) => String(s.app)));
    if (collected.reason === 'no_sources') { yield result([], 'no_sources'); return; }

    // ── template ──
    yield { event: 'phase', data: { phase: 'templating' } };
    const events = makeEvents(collected.events);
    summary.events = events.length;
    summary.templates = new Set(events.map((e) => e.templateId).filter(Boolean)).size;

    // ── mine, score, suppress, rank ──
    yield { event: 'phase', data: { phase: 'mining' } };
    const mined = minePatterns(events, { now, windowDays, timeZone: input.timeZone ?? null });
    yield { event: 'stats', data: { events: summary.events, templates: summary.templates, candidates: mined.candidates.length } };
    if (!mined.candidates.length) { yield result([], mined.reason || 'no_patterns'); return; }
    const inputs = await suppressionInputs(input.userId, now, d);
    const { kept } = suppressCandidates({ ...inputs, now, candidates: mined.candidates.map((c) => enrich(c, now)) });
    const ranked = rank(kept, focusTokens(input.focus)).slice(0, input.maxPatterns ?? MAX_PATTERNS);
    summary.patterns = ranked.length;
    if (!ranked.length) { yield result([], 'no_patterns'); return; }

    // ── mask names: one batched guard call over the templates that will be shown ──
    const withTemplate = ranked.filter((c) => c.template);
    if (withTemplate.length) {
        const masked = await maskNames(withTemplate.map((c) => c.template), { detectPii: d.detectPii });
        withTemplate.forEach((c, i) => { c.template = masked.templates[i] || null; });
        for (const cat of masked.categories) pii.add(cat);
    }
    if (signal?.aborted) return;

    // ── name ──
    yield { event: 'phase', data: { phase: 'naming' } };
    const naming = await d.namePatterns(ranked, { ...(input.naming || {}), signal, windowDays });
    if (signal?.aborted) return;
    for (const cat of naming.categories || []) pii.add(cat);
    const connected = new Set([
        ...[...(input.availableIntegrationIds || [])].map(normaliseApp),
        ...summary.sources.map(normaliseApp),
    ]);
    const suggestions = ranked.map((c, i) => toSuggestion(c, naming.names[i], { now, windowDays, connected }));
    for (const suggestion of suggestions) yield { event: 'suggestion', data: { suggestion } };
    yield result(suggestions, null, naming.usage || null);
}

module.exports = {
    runPatternScan,
    toSuggestion,
    suppressSuggestions,
    scanCacheKey,
    automationShape,
    focusTokens,
    MAX_PATTERNS,
    WINDOW_DAYS,
};
