/**
 * Trigger-source registry — what app_event triggers can exist on this install.
 *
 * An integration declares its own events instead of the platform hardcoding
 * them. One declaration carries BOTH halves so they cannot drift apart:
 *   - the catalog half  (label, events, output fields, sample) that the
 *     builder's provider/event dropdowns and variable picker read, and
 *   - the runtime half  (`scope`, `source`) that decides how the event is
 *     actually produced and who it may fan out to.
 *
 * Three discovery channels, all additive:
 *   1. ./declared/*.js                — first-party providers (readdir at load)
 *   2. ../../mcpServers/<id>/events.js — bundled MCP servers. CommonJS beside
 *      the ESM index.mjs, the same split mcpServers/README.md already
 *      prescribes for tuya.js: requiring index.mjs would start a JSON-RPC
 *      server on stdout.
 *   3. registerTriggerSource()        — runtime push for DB-backed sources
 *      (remote MCP, org custom integrations), mirroring the idiom
 *      core/capabilityRegistry.js uses for MCP capability descriptors.
 *
 * TENANCY: declarations registered with { orgId } are never returned by
 * listTriggerSources(), which feeds the LLM prompt and the test sweep —
 * enumerating them globally would disclose one org's integrations to another.
 * They are reachable only via listTriggerSourcesForOrg(orgId) or an exact-id
 * lookup.
 *
 * A malformed or unloadable manifest is logged and skipped, never fatal: a bad
 * third-party declaration must not take down GET /api/automation/catalog.
 */
const fs = require('fs');
const path = require('path');
const { validateTriggerSource, KNOWN_SOURCE_KINDS } = require('./validate');
const log = require('../../telemetry/log');

const _global = new Map();   // id → declaration (static, bundled, global push)
const _byOrg = new Map();    // orgId → Map<id, declaration>
const _allById = new Map();  // id → declaration across every scope (exact lookup only)
let _loaded = false;

function freeze(decl, origin, orgId) {
    return Object.freeze({ ...decl, _origin: origin, _orgId: orgId || null });
}

/**
 * Register one declaration. Returns the validator's issue records; a
 * declaration carrying any error is rejected outright rather than partially
 * honoured — a half-valid event would be offered in the builder and never fire.
 */
function registerTriggerSource(decl, { origin = 'runtime', orgId = null } = {}) {
    const issues = validateTriggerSource(decl, { existingIds: _global.keys() });
    const errors = issues.filter(i => i.severity === 'error');
    if (errors.length) {
        log.warn(`[triggerSources] rejected "${decl?.id}" from ${origin}: `
            + errors.map(i => `${i.code}@${i.path}`).join(', '));
        return issues;
    }
    const frozen = freeze(decl, origin, orgId);
    if (orgId) {
        if (!_byOrg.has(orgId)) _byOrg.set(orgId, new Map());
        _byOrg.get(orgId).set(frozen.id, frozen);
    } else {
        _global.set(frozen.id, frozen);
    }
    _allById.set(frozen.id, frozen);
    return issues;
}

function takeDeclarations(mod) {
    if (Array.isArray(mod?.TRIGGER_SOURCES)) return mod.TRIGGER_SOURCES;
    if (mod?.TRIGGER_SOURCE) return [mod.TRIGGER_SOURCE];
    return [];
}

function loadFromDir(dir, originPrefix) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {                       // deterministic order
        if (!name.endsWith('.js') || name.includes('.test.')) continue;
        try {
            for (const decl of takeDeclarations(require(path.join(dir, name)))) {
                registerTriggerSource(decl, { origin: `${originPrefix}/${name}` });
            }
        } catch (e) {
            log.warn(`[triggerSources] failed to load ${originPrefix}/${name}: ${e.message}`);
        }
    }
}

function loadBundledMcpManifests() {
    const root = path.join(__dirname, '..', '..', 'mcpServers');
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name, 'events.js');
        if (!fs.existsSync(file)) continue;                  // opt-in: most servers emit nothing
        try {
            for (const decl of takeDeclarations(require(file))) {
                registerTriggerSource(decl, { origin: `mcpServers/${entry.name}` });
            }
        } catch (e) {
            log.warn(`[triggerSources] failed to load mcpServers/${entry.name}/events.js: ${e.message}`);
        }
    }
}

function ensureLoaded() {
    if (_loaded) return;
    _loaded = true;                                          // set first: re-entrancy guard
    loadFromDir(path.join(__dirname, 'declared'), 'declared');
    loadBundledMcpManifests();
}

/** Ordered global declarations. Never includes org-scoped ones. */
function listTriggerSources({ includeHidden = true } = {}) {
    ensureLoaded();
    return [..._global.values()]
        .filter(d => includeHidden || !d.hidden)
        .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label));
}

/** Global declarations plus the ones this org registered. */
function listTriggerSourcesForOrg(orgId, opts) {
    const own = orgId ? [...(_byOrg.get(orgId)?.values() || [])] : [];
    return [...listTriggerSources(opts), ...own]
        .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label));
}

/** Exact lookup. Includes hidden and org-scoped entries — never enumerated. */
function getTriggerSource(id) {
    ensureLoaded();
    return _allById.get(id) || null;
}

function getEventDef(provider, event) {
    const src = getTriggerSource(provider);
    const declared = src ? (src.events || []).find(e => e.id === event) : null;
    if (declared) return declared;
    // Auto-derived events carry their tool in the id, so the polling tick can
    // rebuild the spec from a subscription row alone — no user, no catalog.
    try {
        const { isAutoEventId, deriveEventDef } = require('./autoDerive');
        if (isAutoEventId(event)) return deriveEventDef(event);
    } catch { /* auto-derivation unavailable */ }
    return null;
}

/** Tenancy scope declared by a provider's events, or null when undeclared. */
function getProviderScope(provider) {
    // Auto-derived providers deliberately return null here: they are polled
    // 1:1 per subscription (dispatchToSubscription), never fanned out, and an
    // undeclared scope makes dispatchEvent drop an unidentified event rather
    // than broadcast it — which is the outcome we want either way.
    const src = getTriggerSource(provider);
    if (!src) return null;
    for (const ev of src.events || []) {
        if (ev.scope) return ev.scope;    // validated to be consistent per provider
    }
    return null;
}

/**
 * Can anything actually produce this event? Checked when the catalog is built
 * rather than at registration time, so import order never decides whether an
 * event is listed.
 */
function canProduce(source) {
    return !!source && typeof source.kind === 'string' && KNOWN_SOURCE_KINDS.has(source.kind);
}

/** Test seam — clears every channel so a suite can register its own fixtures. */
function _resetForTests() {
    _global.clear();
    _byOrg.clear();
    _allById.clear();
    _loaded = false;
}

module.exports = {
    registerTriggerSource,
    listTriggerSources,
    listTriggerSourcesForOrg,
    getTriggerSource,
    getEventDef,
    getProviderScope,
    canProduce,
    _resetForTests,
};
