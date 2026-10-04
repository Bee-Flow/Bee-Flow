/**
 * The Privacy Shield's tool block lists (`toolPiiPolicy`), for the paths
 * outside the streaming agent tool loop (BFSF-354).
 *
 * Per tool class the admin picks the kinds of personal data a tool may not
 * handle: "Outside tools" (external) and "Tools that stay on your own server"
 * (internal). The promise on screen: if one of these kinds of data is
 * involved, refuse the tool and strip that data out of whatever comes back.
 * core/agentRuntime/toolRoundExecutor.js kept that promise for streamed agent
 * chats and nowhere else. Every other tool loop ignored both lists: direct
 * chat, the non-streamed agent chat (chatWithAgent, which the support
 * responder uses), swarm workers, the voice turn, the notebook and webpage
 * builder chats, the webpage AI bridge's ask, the Nextcloud Assistant's agent
 * turn, a skill's test run, an automation's AI step, the builder's suggestion scan,
 * the Automation Builder's webpage tools and the cowork/automation runner without
 * an agent. Knowledge-base passages
 * injected into the prompt without a tool call (a project's bases, the bases
 * attached to a chat, an agent without kb_search, a template's, notebook's or
 * webpage's bases) reached the model unfiltered, while the very same passages
 * fetched through kb_search were stripped. Those tool loops use refuseToolCall
 * and stripToolResultForModel below, bound once per loop by toolLoopGate; the
 * injection sites use stripInjectedPassages (stripBlockedFromKbChunks), or
 * stripInjectedText (stripBlockedFromText with the 'internal' class) where the
 * passages arrive as one built text.
 *
 * Each loop passes the shield that already applies to its surface: the turn's
 * resolveShieldFor, a webpage bridge its author's, an automation the policy shield
 * (null when the org keeps automations out of the shield), the cowork runner only
 * when the org opted that path in (core/cowork/coworkShield.js).
 *
 * A knowledge base is an on-box source, so an injected passage is treated as
 * the result of an internal tool.
 *
 * Failure semantics are the agent loop's, exactly:
 *   - the argument check fails CLOSED only when the org's privacy action is
 *     'block' and the class has a non-empty block list; otherwise it fails
 *     open. A degraded scan is a failed scan, not a clean one. A guard that is
 *     not installed at all (detectPii answers null) stays open.
 *   - stripping a result or a passage fails OPEN: a scan error never drops a
 *     turn.
 * Matching goes through orgShield.isBlockedForTool, the one decision the admin
 * route and the agent loop share. Every function takes a RESOLVED shield
 * (resolveShieldFor), which is always `enabled`; anything else is a no-op.
 *
 * The block lists are the resolved `toolPiiPolicy` and nothing else. The
 * legacy Web Search Guard list is not added on top: the resolver absorbs it
 * into `external` only when no explicit policy is stored
 * (orgShield.synthesizeToolPiiPolicy). The streaming agent loop still adds it
 * to every outside tool while the guard is on, and direct chat keeps its own
 * search-only guard; the loops here have neither.
 */

const { _tokenCategoryKey } = require('./piiDetection/tokenizer');
const { isCustomTypeId } = require('./customTypes/ids');
const log = require('../../telemetry/log');

const DEFAULT_THRESHOLD = 0.7;

// Resolved lazily: piiDetection and orgShield both reach the config store at
// require time. Tests replace these through `_deps`.
const _deps = {
    detectPii: (...args) => require('./piiDetection').detectPii(...args),
    orgShield: () => require('./orgShield'),
};

function blockListFor(shield, toolClass) {
    const list = shield?.toolPiiPolicy?.[toolClass]?.blockCategories;
    return Array.isArray(list) ? list.filter(c => typeof c === 'string' && c) : [];
}

function thresholdOf(shield) {
    return typeof shield?.piiDetectionConfidenceThreshold === 'number'
        ? shield.piiDetectionConfidenceThreshold : DEFAULT_THRESHOLD;
}

/** Every category an entity stands for: its own, plus the built-ins an org's own type won over. */
function categoriesOf(entity) {
    const out = entity?.category ? [entity.category] : [];
    if (Array.isArray(entity?.alsoCategories)) out.push(...entity.alsoCategories);
    return out;
}

/** For log lines: an org's own type by id, never by its name. */
function logLabelOf(entity) {
    return isCustomTypeId(entity.category) ? entity.category : (entity.label || entity.category);
}

/**
 * Replace every blocked value in `text` with a fixed `[blocked:<category>]`
 * marker, longest value first so a shorter value inside a longer one cannot
 * corrupt it. The same marker toolResultRedact.js writes in the agent loop.
 */
function replaceBlocked(text, blocked) {
    let out = text;
    const sorted = [...blocked].sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0));
    for (const e of sorted) {
        if (e.text) out = out.split(e.text).join(`[blocked:${e.category ? _tokenCategoryKey(e) : 'pii'}]`);
    }
    return out;
}

/**
 * May this tool be called with these (real-value) arguments?
 *
 * @returns {Promise<{ verdict: 'allow'|'block'|'unavailable', toolClass: string, labels: string[], logLabels: string[] }>}
 *   'block': the arguments carry a category the class forbids;
 *   'unavailable': the scan could not run and the org fails closed.
 */
async function checkToolArgs({ toolName, args, shield }) {
    if (!shield?.enabled) return { verdict: 'allow', toolClass: null, labels: [], logLabels: [] };
    const { classifyToolClass, isBlockedForTool } = _deps.orgShield();
    const toolClass = classifyToolClass(toolName, args || {});
    const allow = { verdict: 'allow', toolClass, labels: [], logLabels: [] };
    const blockList = blockListFor(shield, toolClass);
    if (blockList.length === 0) return allow;

    let scan = null;
    let failed = false;
    try {
        scan = await _deps.detectPii(JSON.stringify(args || {}), blockList, thresholdOf(shield));
    } catch (e) {
        failed = true;
        log.warn('[ToolPiiGate] argument check failed:', e.message);
    }
    if (!failed && scan?.degraded) {
        failed = true;
        log.warn('[ToolPiiGate] argument check degraded:', scan.degradedReason || 'unknown');
    }
    if (failed) {
        return shield.privacyAction === 'block' ? { ...allow, verdict: 'unavailable' } : allow;
    }
    const entities = Array.isArray(scan?.entities) ? scan.entities : [];
    if (entities.length === 0) return allow;

    const verdict = isBlockedForTool(toolName, entities.flatMap(categoriesOf), shield.toolPiiPolicy, args || {});
    if (!verdict.blocked) return allow;
    const hit = new Set(verdict.blockedCategories);
    const blocked = entities.filter(e => categoriesOf(e).some(c => hit.has(c)));
    return {
        verdict: 'block',
        toolClass,
        labels: [...new Set(blocked.map(e => e.label || e.category))],
        logLabels: [...new Set(blocked.map(logLabelOf))],
    };
}

async function _blockedEntitiesIn(text, blockList, shield) {
    const scan = await _deps.detectPii(text, blockList, thresholdOf(shield));
    const set = new Set(blockList);
    return (Array.isArray(scan?.entities) ? scan.entities : [])
        .filter(e => e?.text && categoriesOf(e).some(c => set.has(c)));
}

function _summary(blocked) {
    return {
        blockedCount: blocked.length,
        redactedLabels: [...new Set(blocked.map(e => e.label || e.category))],
        redactedLogLabels: [...new Set(blocked.map(logLabelOf))],
    };
}

/**
 * Strip the categories a tool's class forbids out of the text a tool returned,
 * before the model reads it. Fails open.
 *
 * @returns {Promise<{ text: string, blockedCount: number, redactedLabels: string[], redactedLogLabels: string[] }>}
 */
async function stripBlockedFromText(text, { toolName = null, toolClass = null, shield }) {
    const unchanged = { text, blockedCount: 0, redactedLabels: [], redactedLogLabels: [] };
    if (!shield?.enabled || typeof text !== 'string' || !text) return unchanged;
    try {
        const cls = toolClass || _deps.orgShield().classifyToolClass(toolName);
        const blockList = blockListFor(shield, cls);
        if (blockList.length === 0) return unchanged;
        const blocked = await _blockedEntitiesIn(text, blockList, shield);
        if (blocked.length === 0) return unchanged;
        return { text: replaceBlocked(text, blocked), ..._summary(blocked) };
    } catch (e) {
        log.warn('[ToolPiiGate] result strip failed (fail-open):', e.message);
        return unchanged;
    }
}

/**
 * Strip what the "own server" list forbids out of knowledge-base passages that
 * go into the prompt without a tool call, and out of the citation fields built
 * from them. Rewrites the named string fields of each chunk IN PLACE.
 *
 * One guard request for all chunks together, not one per chunk: the guard
 * admits two requests at a time (requestShaping MAX_INFLIGHT), and a turn that
 * injects six passages must not queue six scans in front of everybody else.
 * Fails open.
 *
 * `labelOf(chunk)` names the line a passage is shown under in the prompt
 * ("### Source 2: <label>"): a document's title or address, which can carry
 * the same data as its text (an e-mail archive titles every message by its
 * sender). kb_search results are stripped whole, titles included, so these
 * labels go through the same scan and come back as `sourceLabels`, one per
 * chunk and always filled; the chunk's own title and address stay untouched
 * for the citation the user opens.
 *
 * @param {Array<object>} chunks
 * @param {object|null} shield  a resolved shield (resolveShieldFor)
 * @param {{ fields?: string[], labelOf?: (chunk: object) => string }} [opts]
 * @returns {Promise<{ blockedCount: number, redactedLabels: string[], redactedLogLabels: string[], sourceLabels: string[] }>}
 */
async function stripBlockedFromKbChunks(chunks, shield, { fields = ['content', 'snippet'], labelOf = null } = {}) {
    const list = Array.isArray(chunks) ? chunks : [];
    const sourceLabels = labelOf ? list.map(c => String(labelOf(c) ?? '')) : [];
    const none = { blockedCount: 0, redactedLabels: [], redactedLogLabels: [], sourceLabels };
    if (!shield?.enabled || list.length === 0) return none;
    const blockList = blockListFor(shield, 'internal');
    if (blockList.length === 0) return none;
    const texts = sourceLabels.filter(Boolean);
    for (const chunk of list) {
        for (const f of fields) {
            if (typeof chunk?.[f] === 'string' && chunk[f]) texts.push(chunk[f]);
        }
    }
    if (texts.length === 0) return none;
    try {
        const blocked = await _blockedEntitiesIn(texts.join('\n\n'), blockList, shield);
        if (blocked.length === 0) return none;
        for (const chunk of list) {
            for (const f of fields) {
                if (typeof chunk?.[f] === 'string' && chunk[f]) chunk[f] = replaceBlocked(chunk[f], blocked);
            }
        }
        return { ..._summary(blocked), sourceLabels: sourceLabels.map(l => replaceBlocked(l, blocked)) };
    } catch (e) {
        log.warn('[ToolPiiGate] knowledge-base strip failed (fail-open):', e.message);
        return none;
    }
}

/**
 * What a tool loop tells the UI and the model when checkToolArgs says no, in
 * the agent loop's words; null when the call may go ahead.
 *
 * @param {{ verdict: string, toolClass: string|null, labels: string[] }} gate
 * @param {string} toolName
 * @returns {{ uiResult: string, modelError: string }|null}
 */
function refusalFor(gate, toolName) {
    if (gate?.verdict === 'unavailable') {
        return {
            uiResult: '[Tool blocked — PII guard unavailable (fail-closed)]',
            modelError: `Tool '${toolName}' was not called: the PII guard is unavailable and org policy fails closed. Ask the user to retry shortly.`,
        };
    }
    if (gate?.verdict !== 'block') return null;
    const labels = gate.labels.join(', ');
    return {
        uiResult: `[Tool blocked — arguments contain sensitive information (${labels})]`,
        modelError: `Tool '${toolName}' was not called: its arguments contained ${labels}, which org policy forbids sending to ${gate.toolClass} tools. Continue without that information or ask the user how to proceed.`,
    };
}

/**
 * The pre-dispatch half for a tool loop: check the arguments, log, and hand
 * back the refusal (refusalFor), or null when the call may go ahead.
 *
 * `logEvent(fields)` receives the guardrail_events fields this gate decides
 * (violation type, categories, direction, action); the caller adds its own
 * attribution (org, user, agent, conversation, source, model) and writes the
 * row, so every loop audits into its own store without this module holding one.
 */
async function refuseToolCall({ toolName, args, shield, logEvent = null, tag = 'ToolPiiGate' }) {
    const gate = await checkToolArgs({ toolName, args, shield });
    const refusal = refusalFor(gate, toolName);
    if (!refusal) return null;
    if (gate.verdict === 'unavailable') {
        log.warn(`[${tag}] '${toolName}' not called — PII guard unavailable and org policy fails closed`);
        return refusal;
    }
    log.info(`[${tag}] '${toolName}' (${gate.toolClass}) BLOCKED — args contain ${gate.logLabels.join(', ')}`);
    if (logEvent) {
        try {
            logEvent({ violation_type: 'pii', violation_categories: gate.labels.join(', '), direction: 'output', action_taken: 'tool_blocked' });
        } catch (_) { /* auditing never decides a tool call */ }
    }
    return refusal;
}

/**
 * The result half for a tool loop: what the MODEL reads, with the categories
 * this tool's class forbids stripped out. Fails open; `logEvent` as above.
 */
async function stripToolResultForModel(content, { toolName, shield, logEvent = null, tag = 'ToolPiiGate' }) {
    if (typeof content !== 'string') return content;
    const r = await stripBlockedFromText(content, { toolName, shield });
    if (r.blockedCount > 0) {
        log.info(`[${tag}] '${toolName}' result redacted (${r.redactedLogLabels.join(', ')})`);
        if (logEvent) {
            try {
                logEvent({ violation_type: 'pii', violation_categories: r.redactedLabels.join(', '), direction: 'input', action_taken: 'tool_result_redacted' });
            } catch (_) { /* auditing never decides a tool call */ }
        }
    }
    return r.text;
}

/**
 * One tool loop's gate, bound once to its shield, its audit and its log tag,
 * so each call site is one short call: `refuse(toolName, args)` is
 * refuseToolCall and `forModel(content, toolName)` stripToolResultForModel,
 * logging as '<tag> ToolPiiGuard' and '<tag> ToolResultDlp'.
 *
 * `shield` is the resolved shield, or an async function that returns it for
 * a loop that resolves it on first use. `audit(fields, toolName)` writes one
 * guardrail_events row, the gate's fields plus the loop's own attribution,
 * and returns the store's promise; a rejected write is swallowed, as the
 * gate swallows every audit failure.
 *
 * @param {{ shield: object|null|(() => Promise<object|null>), audit?: (fields: object, toolName: string) => Promise<unknown>, tag: string }} opts
 * @returns {{ refuse: (toolName: string, args: object) => Promise<{ uiResult: string, modelError: string }|null>, forModel: (content: any, toolName: string) => Promise<any> }}
 */
function toolLoopGate({ shield, audit = null, tag }) {
    const shieldNow = typeof shield === 'function' ? shield : async () => shield;
    const logEventFor = (toolName) => (audit ? (fields) => { audit(fields, toolName).catch(() => {}); } : null);
    return {
        refuse: async (toolName, args) => refuseToolCall({
            toolName, args, shield: await shieldNow(), logEvent: logEventFor(toolName), tag: `${tag} ToolPiiGuard`,
        }),
        forModel: async (content, toolName) => stripToolResultForModel(content, {
            toolName, shield: await shieldNow(), logEvent: logEventFor(toolName), tag: `${tag} ToolResultDlp`,
        }),
    };
}

/**
 * The shield `resolve()` returns (the loop's own resolveShieldFor call), or
 * null when the lookup fails: a failed lookup leaves the block lists
 * unapplied, as a missing shield does, and the log says so.
 */
async function resolveToolShield(resolve, tag) {
    try {
        return await resolve();
    } catch (e) {
        log.warn(`[${tag}] Shield lookup failed; tool block lists not applied:`, e.message);
        return null;
    }
}

/**
 * Knowledge-base text that goes into a prompt without a tool call, already
 * built into one text, with what the "own server" list forbids stripped out
 * and the strip logged under `tag`. Fails open, as stripBlockedFromText does.
 */
async function stripInjectedText(text, { shield, tag, what = 'injected KB passages' }) {
    const r = await stripBlockedFromText(text, { toolClass: 'internal', shield });
    if (r.blockedCount > 0) {
        log.info(`[${tag}] Stripped ${r.redactedLogLabels.join(', ')} from ${what} (own-server block list)`);
    }
    return r.text;
}

/**
 * stripBlockedFromKbChunks on passages that go into a prompt without a tool
 * call, with the strip logged under `tag`. Returns the source labels
 * (`labelOf`) after the same scan, one per chunk.
 */
async function stripInjectedPassages(chunks, { shield, tag, labelOf = null, fields = ['content'] }) {
    const r = await stripBlockedFromKbChunks(chunks, shield, { fields, labelOf });
    if (r.blockedCount > 0) {
        log.info(`[${tag}] Stripped ${r.redactedLogLabels.join(', ')} from injected KB passages (own-server block list)`);
    }
    return r.sourceLabels;
}

/**
 * Knowledge-base passages as the prompt shows them, after
 * stripInjectedPassages: each passage under "### Source N: <label>", the
 * label being the chunk's address, else its title.
 */
async function injectedPassagesPrompt(chunks, { shield, tag }) {
    const labels = await stripInjectedPassages(chunks, { shield, tag, labelOf: c => c.source_uri || c.title || 'KB' });
    return chunks.map((c, i) => `### Source ${i + 1}: ${labels[i]}\n${c.content}`).join('\n\n');
}

module.exports = {
    checkToolArgs, stripBlockedFromText, stripBlockedFromKbChunks,
    refusalFor, refuseToolCall, stripToolResultForModel,
    toolLoopGate, resolveToolShield, stripInjectedText, stripInjectedPassages, injectedPassagesPrompt,
    _deps,
};
