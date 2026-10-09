/**
 * Builder tools — the steps that reach outside the graph: a web service call
 * (with the two ways its answer is remembered, askOnce and cacheInto), a
 * notification to the author, and a write into a knowledge base.
 */

const { newId, appendAfter } = require('../draftGraph');
const { sanitizeForEach, checkTextPlaceholders, checkLoopBindings } = require('../bindings');
const { KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES } = require('../../validate/constants');
const { bindingToTemplate } = require('./inputBindings');
const { normalizeQuery, splitQueryFromUrl, urlHasBracketQuery } = require('../../../core/automationRunner/httpQuery');

/**
 * Check the {{…}} paths inside a step's `query` (keys, values, JSON text) the
 * way url and body are checked. Returns { query, notes, error }.
 */
function checkQueryPlaceholders(query, draft, draftWrap, forEach) {
    if (!query) return { query, notes: [], error: null };
    const notes = [];
    const one = (text, label) => {
        const t = checkTextPlaceholders(text, draft, { draftWrap, label });
        if (t.error) return { error: t.error };
        const l = checkLoopBindings(t.text, draft, forEach, draftWrap, { label });
        if (l.error) return { error: l.error };
        notes.push(...t.notes, ...l.notes);
        return { value: l.value };
    };
    if (query.mode === 'json') {
        const r = one(query.json, 'query.json');
        if (r.error) return { error: r.error };
        return { query: { ...query, json: r.value }, notes };
    }
    const items = [];
    for (let i = 0; i < query.items.length; i++) {
        const k = one(query.items[i].key, `query.items[${i}].key`);
        if (k.error) return { error: k.error };
        const v = one(query.items[i].value, `query.items[${i}].value`);
        if (v.error) return { error: v.error };
        items.push({ key: k.value, value: v.value });
    }
    return { query: { ...query, items }, notes };
}

/**
 * A hand-encoded bracket query in the URL (`?builder%5B0%5D%5Bk%5D=v`) becomes
 * `query`, so the dynamic parts can be bound. Only when the caller sent no
 * query of its own; otherwise a hint says to move it.
 */
function liftUrlQuery(url, query) {
    if (!urlHasBracketQuery(url)) return { url, query, notes: [] };
    if (query) {
        return { url, query, notes: ['url: the URL still carries a hand-encoded nested query next to `query`. Move those parameters into `query` (JSON mode) so they can be bound; the step\'s own parameters win on the same key.'] };
    }
    const split = splitQueryFromUrl(url);
    if (!split) return { url, query, notes: [] };
    return {
        url: split.url,
        query: split.query,
        notes: ['url: the nested query in the URL was moved into `query` (JSON mode). Bind its dynamic parts (domain, page size) to earlier step outputs with {{…}}; values read from a URL are text.'],
    };
}

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

function applyAddHttpRequest(draft, args, draftWrap) {
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { error: feErr };
    if (!args.url || typeof args.url !== 'string') return { error: 'url is required (may contain {{...}} template values)' };
    // url and body are templates the run interpolates: their {{…}} paths get
    // the check an input binding gets.
    const url = checkTextPlaceholders(args.url, draft, { draftWrap, label: 'url' });
    if (url.error) return { error: url.error };
    const body = checkTextPlaceholders(typeof args.body === 'string' ? args.body : '', draft, { draftWrap, label: 'body' });
    if (body.error) return { error: body.error };
    const lifted = liftUrlQuery(url.text, normalizeQuery(args.query));
    const queryChecked = checkQueryPlaceholders(lifted.query, draft, draftWrap, forEach);
    if (queryChecked.error) return { error: queryChecked.error };
    url.text = lifted.url;
    url.notes = [...url.notes, ...lifted.notes, ...queryChecked.notes];
    const loopUrl = checkLoopBindings(url.text, draft, forEach, draftWrap, { label: 'url' });
    const loopBody = checkLoopBindings(body.text, draft, forEach, draftWrap, { label: 'body' });
    if (loopUrl.error || loopBody.error) return { error: loopUrl.error || loopBody.error };
    const warnings = [...(feNotes || []), ...url.notes, ...body.notes, ...loopUrl.notes, ...loopBody.notes];
    const method = String(args.method || 'GET').toUpperCase();
    const headers = (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) ? args.headers : {};
    const step = {
        id: newId('http'),
        type: 'http_request',
        url: loopUrl.value,
        method,
        headers,
        body: loopBody.value,
        ...(queryChecked.query ? { query: queryChecked.query } : {}),
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
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

function applyAddNotification(draft, args, draftWrap) {
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { error: feErr };
    const title = checkTextPlaceholders(args.title, draft, { draftWrap, label: 'title' });
    if (title.error) return { error: title.error };
    const body = checkTextPlaceholders(args.body || '', draft, { draftWrap, label: 'body' });
    if (body.error) return { error: body.error };
    const loopTitle = checkLoopBindings(title.text, draft, forEach, draftWrap, { label: 'title' });
    const loopBody = checkLoopBindings(body.text, draft, forEach, draftWrap, { label: 'body' });
    if (loopTitle.error || loopBody.error) return { error: loopTitle.error || loopBody.error };
    const warnings = [...(feNotes || []), ...title.notes, ...body.notes, ...loopTitle.notes, ...loopBody.notes];
    const step = {
        id: newId('notif'),
        type: 'notification',
        title: loopTitle.value,
        body: loopBody.value,
        channels: Array.isArray(args.channels) ? args.channels : ['notification'],
        label: args.label || 'Notification',
        ...(forEach ? { forEach } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(warnings.length ? { _warnings: warnings } : {}) };
}

/**
 * A write into a knowledge base.
 *
 * `label` is written as `args.label || 'To knowledge base'` in ONE object
 * literal alongside `type: 'knowledge_write'` — flow/nodeDefs.serverLabels.test.js
 * scans this file with a regex over exactly that shape and requires the literal
 * to equal NODE_DEFS.knowledge_write.defaultLabel.
 *
 * `content`, `title` and `sourceUri` are `{{…}}` template STRINGS, the shape
 * `generate_document` uses and the shape the editor's text areas produce. The
 * model is told that in the schema, but it has seen a thousand builder tools
 * that take binding objects and will hand one over anyway — so a binding is
 * FLATTENED back to a template string here rather than stored in a second
 * shape the editor cannot render and `collectRefPaths` would have to guess at.
 *
 * There is deliberately no authorisation check in this file: it is pure and
 * DB-free like every other builder. The knowledge base is checked at save and
 * at activate (`core/kb/automationKbCheck`), and again at run time.
 */
function applyAddKnowledgeWrite(draft, args, draftWrap) {
    const { forEach, error: feErr, notes: feNotes } = sanitizeForEach(args.forEach, draft, draftWrap);
    if (feErr) return { error: feErr };
    const step = {
        id: newId('kbw'),
        type: 'knowledge_write',
        label: args.label || 'To knowledge base',
        ...(forEach ? { forEach } : {}),
        knowledgeBaseId: typeof args.knowledgeBaseId === 'string' ? args.knowledgeBaseId.trim() : '',
        title: bindingToTemplate(args.title),
        content: bindingToTemplate(args.content),
        sourceUri: bindingToTemplate(args.sourceUri),
    };
    // 'skip' is the default and stays IMPLICIT, so a freshly-built step does
    // not differ from a stored one for no behavioural reason.
    if (KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES.includes(args.nearDuplicateStrategy) && args.nearDuplicateStrategy !== 'skip') {
        step.nearDuplicateStrategy = args.nearDuplicateStrategy;
    }
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    return { added: step, ...(feNotes && feNotes.length ? { _warnings: feNotes } : {}) };
}

module.exports = {
    normalizeAskOnce,
    normalizeCacheInto,
    checkQueryPlaceholders,
    liftUrlQuery,
    applyAddHttpRequest,
    applyAddNotification,
    applyAddKnowledgeWrite,
};
