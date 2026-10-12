// @typecheck
'use strict';
/**
 * Ideas mode: the model-led scan, kept for the meeting-notes RulesPanel and
 * the "Suggest ideas instead" link. A fast-tier model gets the user's
 * read-only tools and a digest of their own tool activity, reads a few apps,
 * and returns automation IDEAS through a forced tool call. Unlike the pattern
 * scan, nothing here is measured: the ideas are the model's, the evidence and
 * value next to them are the server's (automation/suggestions.js).
 *
 * The loop's bounds:
 *   - at most SUGGEST_MAX_ROUNDS model rounds and SUGGEST_MAX_TOOL_CALLS reads;
 *   - breadth first: no second read of one app while another readable app is
 *     unread (the model otherwise spends the budget on one inbox), and at most
 *     SUGGEST_MAX_READS_PER_INTEGRATION per app;
 *   - read-only tools only, checked twice (here and by the tool list).
 *
 * Privacy:
 *   - every read goes through the scan reader (Shield block lists, egress
 *     ledger under `pattern_scan`) and its output through guardToolOutput,
 *     one token namespace per scan; a blocked output reaches the model as a
 *     "[withheld …]" line;
 *   - the prompt (focus, the user's automation titles) goes through
 *     guardAiInput first; when that blocks, the scan runs without them;
 *   - the activity digest is the user's OWN tool calls, never the org's;
 *   - an idea's title, description and build prompt lose any e-mail address,
 *     link or host before they are streamed or cached (withoutContacts).
 *
 * Collaborators come in through `overrides` (lazily loaded otherwise).
 */

const log = require('../../telemetry/log');
const { depsWith } = require('./depsWith');
const lib = require('../suggestions');
const { maskContacts } = require('./templating');

// The model must READ the user's data to find concrete repeating work; the
// digest only says which tools to read first. The efficiency win is the forced
// structured synthesis and the cache, not skipping reads.
const SUGGEST_MAX_ROUNDS = 6;
const SUGGEST_MAX_TOOL_CALLS = 12;
const SUGGEST_MAX_SUGGESTIONS = 6;
const SUGGEST_MAX_READS_PER_INTEGRATION = 4;
const WINDOW_DAYS = 90;
// 4096, not 2500: six suggestions with full build prompts truncate the tool
// call's JSON at 2500. reasoningEffort 'none': a self-hosted Qwen3 otherwise
// spends the whole budget thinking and returns no tool call.
const CALL_OPTIONS = Object.freeze({ maxTokens: 4096, temperature: 0.2, reasoningEffort: 'none' });

const LOADERS = {
    llmClient: () => require('../../core/llm/llmClient'),
    isSideEffect: () => require('../sideEffectMap').isSideEffect,
    resolveIntegration: () => require('../../core/integrations/integrationToolMap').resolveIntegration,
    getIntegrationByTool: () => (/** @type {any} */ f) => require('../../stores/integrationActivityStore').getIntegrationByTool(f),
    getAutomations: () => (/** @type {string} */ userId) => require('../../stores/automationStore').getAutomationsForUser(userId),
    getRecentSuppressedTitles: () => (/** @type {any} */ p) => require('../../stores/suggestionFeedbackStore').getRecentSuppressedTitles(p),
    guardToolOutput: () => require('../../core/automationRunner/safety').guardToolOutput,
    guardAiInput: () => require('../../core/automationRunner/safety').guardAiInput,
};

/** @param {Record<string, any>|null|undefined} overrides */
const depsFor = (overrides) => depsWith(LOADERS, overrides);

/** The integration a tool belongs to: the tool map's id, else the name's prefix. */
function integrationOf(resolveIntegration, toolName) {
    let id = null;
    try { id = resolveIntegration(toolName)?.integration || null; } catch (_) { /* unknown tool */ }
    return String(id || String(toolName).split('_')[0] || '').toLowerCase();
}

/**
 * The user's titles to keep out of the ideas: their automations and the
 * ideas they dismissed, built or asked about.
 * @param {string} userId
 * @param {any} d deps
 */
async function existingTitlesFor(userId, d) {
    const [automations, suppressed] = await Promise.all([
        Promise.resolve().then(() => d.getAutomations(userId)).catch(() => []),
        Promise.resolve().then(() => d.getRecentSuppressedTitles({ userId })).catch(() => []),
    ]);
    const own = (Array.isArray(automations) ? automations : []).map((a) => a?.title).filter(Boolean).slice(0, 50);
    return [...new Set([...own, ...(Array.isArray(suppressed) ? suppressed : [])])];
}

/**
 * An idea's texts without any e-mail address, link or host. The model read
 * the user's mail and files and is asked for concrete specifics; the result
 * is streamed, cached and handed to the builder, so an address it quoted is
 * replaced by words ("an email address") here, once, for all three.
 * @param {any} s a normalised suggestion
 */
function withoutContacts(s) {
    const clean = (v) => (typeof v === 'string' ? maskContacts(v, { words: true }) : v);
    return { ...s, title: clean(s.title), description: clean(s.description), buildPrompt: clean(s.buildPrompt) };
}

/**
 * Drop cached ideas the user has since dismissed, built or automated (the
 * cache key no longer carries the titles, so this runs on every cache read).
 * @param {any[]} suggestions
 * @param {{ userId: string }} p
 * @param {Record<string, any>|null} [overrides]
 */
async function suppressIdeas(suggestions, { userId }, overrides = null) {
    const list = Array.isArray(suggestions) ? suggestions : [];
    if (!list.length) return list;
    const titles = await existingTitlesFor(userId, depsFor(overrides));
    if (!titles.length) return list;
    return list.filter((s) => !titles.some((t) => lib.titlesSimilar(String(s?.title || ''), t)));
}

/**
 * @param {{
 *   userId: string, orgId?: string|null,
 *   integrationIds?: string[], focus?: string,
 *   tools: any[], availableIntegrationIds: Set<string>,
 *   modelId: string, policy: any, auditBase: any, guardCtx: any,
 *   reader: { read: (name: string, args: object) => Promise<any>, gate: { forModel: (content: any, toolName: string) => Promise<any> } },
 *   send: (event: string, data: any) => void, signal?: AbortSignal,
 * }} input
 * @param {Record<string, any>|null} [overrides]
 * @returns {Promise<{ suggestions: any[], summary: Record<string, any>, reason?: string, usage: any }>}
 */
async function runIdeasScan(input, overrides = null) {
    const d = depsFor(overrides);
    const { userId, send, signal, policy, auditBase, guardCtx } = input;
    const integOf = (name) => integrationOf(d.resolveIntegration, name);
    const emptySummary = { integrations: [], toolCalls: 0, piiCategories: [], rounds: 0, structured: false };

    // ── Which apps: the picked ones the user has ([] means all of them) ──
    const picked = new Set((input.integrationIds || []).map((s) => String(s).toLowerCase()));
    const available = [...input.availableIntegrationIds];
    const focusInteg = picked.size ? available.filter((id) => picked.has(id)) : available;
    if (!focusInteg.length) return { suggestions: [], summary: emptySummary, reason: 'no_integrations', usage: null };
    const focusSet = new Set(focusInteg);
    const scanTools = (input.tools || []).filter((t) => {
        const name = t?.function?.name;
        return name && !d.isSideEffect(name) && focusSet.has(integOf(name));
    });

    // ── The user's own activity and titles ──
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const filter = lib.resolveActivityFilter({ userId });
    const [activityRows, existingTitles] = await Promise.all([
        filter.userId
            // manualOnly: chat-initiated calls only, the miner's allow-list, so
            // neither automations nor earlier scans' own reads count as the user's work.
            ? Promise.resolve().then(() => d.getIntegrationByTool({ ...filter, startDate: since, excludeDryRun: true, manualOnly: true })).catch(() => [])
            : [],
        existingTitlesFor(userId, d),
    ]);
    const activityByTool = (Array.isArray(activityRows) ? activityRows : []).filter((r) => r && r.tool_name && Number(r.total) > 0
        && focusSet.has(String(r.integration_type || '').toLowerCase()));
    const activityIndex = lib.buildActivityIndex(activityByTool);

    // ── Prompt, through the Shield ──
    const promptFor = (focus, titles) => {
        const digest = lib.buildScanDigest({ activityByTool, existingTitles: [], focus: '', toolShapes: {} });
        return [
            { role: 'system', content: lib.buildScanSystemPrompt({ selectedIntegrations: focusInteg, activityHints: [], existingTitles: titles, focus, maxSuggestions: SUGGEST_MAX_SUGGESTIONS }) },
            { role: 'user', content: `Recent tool activity (frequency signal):\n\n${digest}\n\nScan my connected tools for repeating work and call return_suggestions with up to ${SUGGEST_MAX_SUGGESTIONS} automation ideas.` },
        ];
    };
    let messages = promptFor(input.focus || '', existingTitles);
    const allCategories = new Set();
    try {
        const g = await d.guardAiInput(messages, policy, auditBase, 'live', guardCtx);
        for (const c of g?.categories || []) allCategories.add(c);
        if (g?.blocked) messages = promptFor('', []);
    } catch (err) {
        log.warn('[RepeatingWork] ideas prompt guard failed, scanning without focus and titles:', /** @type {any} */ (err)?.message);
        messages = promptFor('', []);
    }

    // ── The loop's reads ──
    const scannedIntegrations = new Set();
    const readsByIntegration = new Map();
    const readable = new Set(scanTools.map((t) => integOf(t?.function?.name)).filter(Boolean));
    let toolCalls = 0;

    const boundedExecute = async (name, args) => {
        if (signal?.aborted) return 'Scan cancelled.';
        if (d.isSideEffect(name)) return `Error: ${name} is a write action and is not allowed during a read-only scan.`;
        const integration = integOf(name);
        const used = readsByIntegration.get(integration) || 0;
        // A steer is a redirect: no scan_step, no budget spent.
        if (used >= 1) {
            const unsampled = [...readable].filter((i) => i !== integration && !readsByIntegration.has(i));
            if (unsampled.length) {
                return `You've already looked at ${integration}. Take ONE quick look at each selected app you haven't checked yet first: ${unsampled.join(', ')}. Read one of those now, then come back to ${integration} only if you still need more signal.`;
            }
        }
        if (used >= SUGGEST_MAX_READS_PER_INTEGRATION) {
            return `You've sampled ${integration} enough (${used} reads) to see its patterns. Read a different app, or if you have enough signal, stop and call return_suggestions now.`;
        }
        toolCalls++;
        if (toolCalls > SUGGEST_MAX_TOOL_CALLS) return 'Tool-call budget reached — stop scanning and call return_suggestions now.';
        // Counted before the read, so a failing tool is not retried forever.
        readsByIntegration.set(integration, used + 1);
        send('scan_step', { tool: name, integration, phase: 'start' });

        const r = await input.reader.read(name, args);
        if (!r.ok) {
            send('scan_step', { tool: name, integration, phase: 'done', ok: false });
            return r.refusal ? JSON.stringify({ error: r.refusal.modelError }) : `Error: ${r.error && r.error.message}`;
        }
        let guardedText;
        let categories = [];
        let blocked = false;
        try {
            // guardCtx: one token namespace for the whole scan, so one person
            // read from two apps reaches the model as one placeholder.
            const g = await d.guardToolOutput(r.value, policy, auditBase, 'live', guardCtx);
            guardedText = typeof g.result === 'string' ? g.result : JSON.stringify(g.result);
            categories = g.categories || [];
        } catch (e) {
            blocked = true;
            categories = /** @type {any} */ (e)?.categories || [];
            guardedText = `[withheld: contains sensitive data${categories.length ? ` (${categories.join(', ')})` : ''}]`;
        }
        scannedIntegrations.add(integration);
        for (const c of categories) allCategories.add(c);
        send('scan_step', { tool: name, integration, phase: 'done', ok: !blocked, piiCategories: categories });
        return input.reader.gate.forModel(guardedText, name);
    };

    // ── Scan ──
    const callOpts = signal ? { ...CALL_OPTIONS, signal } : { ...CALL_OPTIONS };
    let rounds = 0;
    let structured = null;
    let content = null;
    let usage = null;
    send('phase', { phase: 'scanning' });
    if (scanTools.length === 0) {
        const res = await d.llmClient.chatForcedTool(input.modelId, messages, lib.SUGGESTIONS_TOOL, callOpts);
        structured = res?.structured || null;
        content = res?.content ?? null;
        usage = res?.usage || null;
    } else {
        const loop = await d.llmClient.runToolLoop(input.modelId, messages, scanTools,
            { ...callOpts, finalTool: lib.SUGGESTIONS_TOOL }, boundedExecute, SUGGEST_MAX_ROUNDS);
        rounds = loop?.toolCallRounds ?? 0;
        structured = loop?.structured || null;
        content = loop?.content ?? null;
        usage = loop?.usage || null;
    }
    send('phase', { phase: 'synthesising' });

    const raw = structured ? lib.extractSuggestionsFromToolCall(structured) : lib.parseSuggestionsJson(content);
    const suggestions = lib.normaliseSuggestions(raw, /** @type {any} */ ({
        availableIntegrationIds: input.availableIntegrationIds, existingTitles, max: SUGGEST_MAX_SUGGESTIONS, activityIndex,
    })).map(withoutContacts);
    log.info('[RepeatingWork] ideas user=%s model=%s rounds=%s reads=%s raw=%s structured=%s final=%s',
        userId, input.modelId, rounds, toolCalls, Array.isArray(raw) ? raw.length : 0, !!structured, suggestions.length);

    return {
        suggestions,
        summary: { integrations: [...scannedIntegrations], toolCalls, piiCategories: [...allCategories], rounds, structured: !!structured },
        reason: suggestions.length ? undefined : 'no_patterns',
        usage,
    };
}

module.exports = {
    runIdeasScan,
    suppressIdeas,
    integrationOf,
    SUGGEST_MAX_ROUNDS,
    SUGGEST_MAX_TOOL_CALLS,
    SUGGEST_MAX_SUGGESTIONS,
    SUGGEST_MAX_READS_PER_INTEGRATION,
};
