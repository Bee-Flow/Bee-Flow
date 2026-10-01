/**
 * Builder tools — the steps that reach outside the graph: a web service call
 * (with the two ways its answer is remembered, askOnce and cacheInto), a
 * notification to the author, and a write into a knowledge base.
 */

const { newId, appendAfter } = require('../draftGraph');
const { sanitizeForEach } = require('../bindings');
const { KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES } = require('../../validate/constants');
const { bindingToTemplate } = require('./inputBindings');
const { textFieldValue } = require('../picks');
const { hasText } = require('../../validate/helpers');

// A text field of this file's steps in its stored form: a `{{ }}` text the
// shared core can hold becomes a compose (a list in it renders readable, not
// as JSON), anything else keeps the coercion the field always had.
const text = (stepType, field, value, fallback) => textFieldValue(value, { stepType, field, fallback });

/**
 * `askOnce` in exactly the two shapes the runtime reads: `true` (reuse within
 * the run) or `{ acrossRuns?, ttlSeconds? }` (that, plus the wider promise).
 * Anything else is absent, which is off.
 *
 * Lives here rather than in stepEditing so BOTH paths can reach it — that file
 * already requires this one, so the reverse would be a cycle — and so an added
 * step and a patched one are byte-identical.
 */
function normalizeAskOnce(value) {
    if (value === true) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out = {};
    if (value.acrossRuns === true) out.acrossRuns = true;
    const ttl = Number(value.ttlSeconds);
    // Out of range is left ALONE rather than clamped: the validator's
    // ask_once_ttl_range error is how the model finds out it asked for
    // something impossible, and a silent clamp would teach it nothing.
    if (Number.isFinite(ttl)) out.ttlSeconds = Math.round(ttl);
    // An object with nothing recognised in it still means "ask once per run".
    return Object.keys(out).length ? out : true;
}

/**
 * `cacheInto` in the one shape the runtime reads: `{datatableId, maxAgeDays?}`.
 * Anything without a table id is absent, which is off — a model reaching for
 * this otherwise invents `{enabled: true}` and persists a setting that looks
 * configured and does nothing.
 *
 * maxAgeDays is left ALONE when out of range, for the same reason
 * normalizeAskOnce leaves ttlSeconds alone: the validator's
 * cache_into_max_age_range error is how the model learns, and a silent clamp
 * teaches it nothing.
 */
function normalizeCacheInto(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const datatableId = typeof value.datatableId === 'string' ? value.datatableId.trim() : '';
    if (!datatableId) return undefined;
    const days = Number(value.maxAgeDays);
    return {
        datatableId,
        ...(Number.isFinite(days) ? { maxAgeDays: Math.round(days) } : {}),
    };
}

function applyAddHttpRequest(draft, args) {
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const url = text('http_request', 'url', args.url, () => undefined);
    if (!hasText(url)) return { error: 'url is required (may contain {{...}} template values)' };
    const method = String(args.method || 'GET').toUpperCase();
    const headers = (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) ? args.headers : {};
    const step = {
        id: newId('http'),
        type: 'http_request',
        url,
        method,
        headers,
        body: text('http_request', 'body', args.body, () => ''),
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 10000,
        // blockPrivateTargets defaults TRUE (safe): only reaches localhost /
        // private-network / cloud-metadata targets when the caller explicitly
        // sets it false (a deliberate opt-out for internal endpoints).
        blockPrivateTargets: args.blockPrivateTargets === false ? false : true,
        parseResponse: ['never', 'always'].includes(args.parseResponse) ? args.parseResponse : undefined,
        // "Ask this web service only once" — GET/HEAD only, and the validator
        // errors on a write method rather than letting a reused answer mean a
        // second POST silently never happens. Rebuilt through the same
        // normalizer builder_update_step uses, so an added step and a patched
        // one are the same object.
        ...(args.askOnce !== undefined && normalizeAskOnce(args.askOnce) !== undefined
            ? { askOnce: normalizeAskOnce(args.askOnce) } : {}),
        // "Remember answers in a table" — the VISIBLE half of the same idea,
        // and an independent tick: answers land as ordinary rows the author can
        // read, correct and export, expired by the table's own retention window
        // rather than by a hidden TTL.
        ...(normalizeCacheInto(args.cacheInto) !== undefined
            ? { cacheInto: normalizeCacheInto(args.cacheInto) } : {}),
        label: args.label || 'Call a web service',
        // Saved-credential reference only — the secret lives in the org vault
        // and is injected at run time, never stored in the definition.
        ...(typeof args.authConnectionId === 'string' && args.authConnectionId
            ? { auth: { connectionId: args.authConnectionId } } : {}),
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

function applyAddNotification(draft, args) {
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('notif'),
        type: 'notification',
        title: text('notification', 'title', args.title),
        body: text('notification', 'body', args.body || ''),
        channels: Array.isArray(args.channels) ? args.channels : ['notification'],
        label: args.label || 'Notification',
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

/**
 * A write into a knowledge base.
 *
 * `label` is written as `args.label || 'To knowledge base'` in ONE object
 * literal alongside `type: 'knowledge_write'` — flow/nodeDefs.serverLabels.test.js
 * scans this file with a regex over exactly that shape and requires the literal
 * to equal NODE_DEFS.knowledge_write.defaultLabel.
 *
 * `content`, `title` and `sourceUri` are text fields, the shape
 * `generate_document` uses: a `{{…}}` text the model writes is stored as a
 * compose (a text with picked values) where every placeholder reads a plain
 * path, else as the template it is. The model is told that in the schema, but
 * it has seen a thousand builder tools that take binding objects and will hand
 * one over anyway — so a legacy binding is FLATTENED back to its text here
 * rather than stored in a second shape the editor cannot render.
 *
 * There is deliberately no authorisation check in this file: it is pure and
 * DB-free like every other builder. The knowledge base is checked at save and
 * at activate (`core/kb/automationKbCheck`), and again at run time.
 */
function applyAddKnowledgeWrite(draft, args) {
    const { forEach, error: feErr } = sanitizeForEach(args.forEach, draft);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('kbw'),
        type: 'knowledge_write',
        label: args.label || 'To knowledge base',
        ...(forEach ? { forEach } : {}),
        knowledgeBaseId: typeof args.knowledgeBaseId === 'string' ? args.knowledgeBaseId.trim() : '',
        title: text('knowledge_write', 'title', args.title, bindingToTemplate),
        content: text('knowledge_write', 'content', args.content, bindingToTemplate),
        sourceUri: text('knowledge_write', 'sourceUri', args.sourceUri, bindingToTemplate),
    };
    // 'skip' is the default and stays IMPLICIT, so a freshly-built step does
    // not differ from a stored one for no behavioural reason.
    if (KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES.includes(args.nearDuplicateStrategy) && args.nearDuplicateStrategy !== 'skip') {
        step.nearDuplicateStrategy = args.nearDuplicateStrategy;
    }
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step };
}

module.exports = {
    normalizeAskOnce,
    normalizeCacheInto,
    applyAddHttpRequest,
    applyAddNotification,
    applyAddKnowledgeWrite,
};
