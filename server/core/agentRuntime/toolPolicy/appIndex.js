// @typecheck
/**
 * The appId ↔ tool-name INDEX, built from `ALL_TOOL_APPS`, and every reader of
 * it: which app owns a name, which actions an app owns, which apps get a say
 * about one call, which apps must be named before they grant anything — and,
 * before all of those, whether attribution can be trusted at all.
 *
 * A grant keyed on an app is only meaningful while this index can say who owns
 * a name, so `isAttributionAvailable` is the question every grant reader in
 * this folder has to ask first.
 */

'use strict';
const { featureModule } = require('../../featureModules');
const log = require('../../../telemetry/log');

// ── appId ↔ tool names ──────────────────────────────────────────────
// Built from `ALL_TOOL_APPS` in automation/toolRegistry.js — the SAME list the
// agent tool picker renders from (routes/agents/toolCatalog.js), so the picker
// and the runtime cannot disagree about which app owns `gmail_compose`. A
// separate hand-written map here would be a second thing to keep in step, and
// the one that drifts is the one nobody looks at.
//
// It reads ALL_TOOL_APPS and not TOOL_REGISTRY because that is exactly how
// `browse_web` escaped: it is registered INLINE (behind a docker probe) rather
// than as a TOOLS-array module, so no registry row claimed it, so this index
// answered "no app owns this name" — the answer reserved for `set_reminder`
// and friends — and `isToolAllowed` waved it past a curated agent's grants.
//
// ── A DEGRADED INDEX IS NOT AN ANSWER ───────────────────────────────
// This index does not swallow a registry failure and hand back an EMPTY one: then
// every tool would be "unattributed" and every per-action grant would match
// nothing — an agent curated down to `gmail_search` would be handed `gmail_compose`
// and `drive_delete` on the strength of a require that threw. So the index
// carries `ok`, and every reader that would otherwise conclude "no app claims
// this name" has to ask whether the registry actually SAID so. `ok` is false
// when the registry could not be loaded, when a single entry's tools failed to
// load (attribution is then incomplete, and an incomplete answer is not a fact)
// and when the index came back empty. A degraded index is rebuilt on the next
// read after a short cooldown: a transient failure at boot must not deny a
// curated agent its whole toolbelt until the process restarts.
let _appIndex = null;
const INDEX_RETRY_MS = 30000;
function _buildAppIndex() {
    const byTool = new Map();
    const byApp = new Map();
    const claimants = new Map();
    const requiresEntry = new Set();
    const defersGrants = new Set();
    const failed = [];
    let ok = true;
    try {
        const registry = featureModule('automation/toolRegistry');
        const { ALL_TOOL_APPS } = registry;
        // ── "LOADTOOLS THREW" WAS NOT A SIGNAL (A2 contradiction) ────
        // The real `loadTools` catches its own error and returns `[]`, so the catch below NEVER fired: a module that did not load
        // yielded `byApp.set(app, [])`, `ok` stayed true, and every name of that app became UNATTRIBUTED — the reading that is
        // meant for `set_reminder` and that every per-app grant passes. `loadToolsResult` returns the fault as a value; that is the
        // difference between "this app has no tools" and "I could not read this app".
        //
        // A registry WITHOUT that function (an older stub) cannot tell those two apart. Then empty is the narrow answer: better a
        // degraded index — in which a curated agent gets nothing from the registry — than an index that silently lets everything through.
        const readTools = typeof registry.loadToolsResult === 'function'
            ? (e) => registry.loadToolsResult(e)
            : (e) => { const t = registry.loadTools(e) || []; return { tools: t, ok: t.length > 0 }; };
        for (const entry of ALL_TOOL_APPS || []) {
            if (!entry || !entry.app) continue;
            if (entry.grantsRequireEntry === true) requiresEntry.add(entry.app);
            // ── TWO ENTRIES, ONE SET OF NAMES (A2-4) ──────────────────
            // `outlook` and `outlook-readonly` load the same module: the same names, the same credentials, of which the second supplies
            // a strict subset. Ownership followed the ORDER of the registry until A2-4 ("the first wins"), so `outlook-readonly` owned
            // no name and a grant stored on it went nowhere — storable and silently dead, exactly what the module header forbids.
            //
            // Now the registry points the owner OUT (`grantsVia`): an entry that lets its grants run elsewhere never owns a name.
            // Swapping two rows can therefore no longer move the ownership — and with it the place where the identity question
            // (`actAs`) is answered.
            const defersTo = typeof entry.grantsVia === 'string' && entry.grantsVia ? entry.grantsVia : null;
            if (defersTo) defersGrants.add(entry.app);
            let res;
            try { res = readTools(entry); } catch (_) { res = null; }
            if (!res || res.ok !== true) { failed.push(entry.app); ok = false; continue; }
            const tools = Array.isArray(res.tools) ? res.tools : [];
            /** @type {string[]} */
            const names = [];
            for (const t of tools) {
                const name = t && t.function && t.function.name;
                if (typeof name !== 'string' || !name) continue;
                names.push(name);
                // Everyone who SUPPLIES the name is remembered, including the app that
                // does not own it: `isToolAllowed` lets every claiming app state its grant, so the narrowest wins.
                if (!claimants.has(name)) claimants.set(name, []);
                const ids = claimants.get(name);
                if (!ids.includes(entry.app)) ids.push(entry.app);
                if (!defersTo && !byTool.has(name)) byTool.set(name, entry.app);
            }
            byApp.set(entry.app, names);
        }
        // A name that is supplied only by deferring entries (the owner is missing or did not load) may not end up UNATTRIBUTED: that is
        // the reading that is meant for `set_reminder` and that every per-app grant would pass. The first claiming app is then the
        // owner, and the grants of the rest keep deciding.
        for (const [name, ids] of claimants) {
            if (!byTool.has(name) && ids.length) byTool.set(name, ids[0]);
        }
        // Eigenaar vooraan: lezers die één app nodig hebben (confirm-default,
        // provider) en lezers die alle claimanten aflopen, zien dezelfde
        // volgorde.
        for (const [name, ids] of claimants) {
            const owner = byTool.get(name);
            const i = ids.indexOf(owner);
            if (i > 0) { ids.splice(i, 1); ids.unshift(owner); }
        }
    } catch (e) {
        ok = false;
        log.error('[ToolPolicy] Tool registry unavailable — tool attribution is degraded, so a ' +
            'curated agent is served NO registry tools until it recovers:', /** @type {Error} */ (e).message);
    }
    if (ok && byTool.size === 0) {
        ok = false;
        log.error('[ToolPolicy] Tool registry produced an empty index — treating attribution as degraded');
    } else if (failed.length) {
        // Say precisely what happens: the names of THESE apps can no longer be attributed, and a curated agent therefore no longer gets
        // them. The apps that DID load remain decided by their own grant — that is not a widening (it was that way there already),
        // and it saves a complete tool belt when one module breaks.
        log.error(`[ToolPolicy] Tool registry entries failed to load (${failed.join(', ')}) — ` +
            'attribution is incomplete: a curated agent is served NONE of their tools until it recovers');
    }
    return { byTool, byApp, claimants, requiresEntry, defersGrants, ok, builtAt: Date.now() };
}
function _index() {
    if (_appIndex && (_appIndex.ok || Date.now() - _appIndex.builtAt < INDEX_RETRY_MS)) return _appIndex;
    _appIndex = _buildAppIndex();
    return _appIndex;
}
/**
 * Can this process tell which app owns a tool name at all?
 *
 * The question every grant reader has to ask before it reads "nobody claims
 * this name" as permission.
 */
function isAttributionAvailable() { return _index().ok === true; }
/** Test seam: drop the memoised registry index. */
function _resetAppIndex() { _appIndex = null; }

/**
 * The app id that owns a tool NAME, or null when nothing claims it.
 *
 * Null is not a failure: `set_reminder`, `activate_skill`, component tools and
 * the built-ins have no app, and a grant keyed on an app can therefore never
 * speak about them. Use `appIdForToolDef` when you hold the whole tool object
 * — MCP and custom-integration tools carry their own id and this cannot see it.
 * @param {string} toolName
 */
function appIdForTool(toolName) {
    if (typeof toolName !== 'string' || !toolName) return null;
    return _index().byTool.get(toolName) || null;
}

/**
 * The app id for a whole tool DEFINITION. MCP servers (`mcp:<serverId>`) and
 * org custom integrations (`custom:<id>`) are integrations with grants of their
 * own, and their tool names are not in the registry — without this they would
 * silently fall through every per-action grant.
 */
function appIdForToolDef(tool) {
    if (!tool || typeof tool !== 'object') return null;
    const serverId = tool._mcp && tool._mcp.serverId;
    if (serverId) return `mcp:${serverId}`;
    const customId = tool._custom && (tool._custom.integrationId || tool._custom.id);
    if (customId) return `custom:${customId}`;
    return appIdForTool(tool.function && tool.function.name);
}

/**
 * Every action name an app owns (empty array for an unknown app).
 * @param {string} appId
 */
function actionsOfApp(appId) {
    if (typeof appId !== 'string' || !appId) return [];
    return _index().byApp.get(appId) || [];
}

/**
 * Every app whose grant has a say about ONE tool call — the owner first.
 *
 * Normally exactly one: the app that owns the name. It is more when two
 * registry entries ship the same tool (`outlook` and `outlook-readonly`: the
 * same names on the same credentials, one a strict subset of the other). The
 * grant of EACH of them then has to allow the call, which is the only reading
 * that never widens: an app the map does not mention still means "every action
 * of this app" (the no-migration rule), and an app that IS mentioned and does
 * not list this name is a refusal that has to survive.
 *
 * Deliberately keyed on the NAME the registry knows. An MCP or custom tool
 * carries its own id (`appIdForToolDef`) and is never attributed by name, so
 * it is returned alone even if a registry app happens to ship the same name —
 * borrowing another app's grant for it would be attribution by coincidence.
 * @param {string} toolName
 */
function _decidingApps(appId, toolName) {
    if (typeof toolName !== 'string' || !toolName) return [appId];
    const ids = _index().claimants.get(toolName);
    if (!Array.isArray(ids) || ids.length < 2 || !ids.includes(appId)) return [appId];
    return ids;
}

/**
 * Must a curated agent NAME this app before it gets anything from it?
 *
 * True only for the apps whose tools are injected inline and which the picker
 * could not show until A2-1 — `grantsRequireEntry` in
 * automation/toolRegistry.js.
 *
 * The DECLARATION is read before the module is loaded, so an app whose tools alone do not load is still in there — the narrow
 * side. A registry that is unreadable as a whole yields an empty set and therefore `false`; that widens nothing, because the
 * degraded branch in `isToolAllowed` above refuses those names anyway.
 * @param {string} appId
 */
function appRequiresExplicitGrant(appId) {
    if (typeof appId !== 'string' || !appId) return false;
    const idx = _index();
    return idx.requiresEntry instanceof Set && idx.requiresEntry.has(appId);
}

/**
 * Does this app ship someone else's tools? (`grantsVia` in the registry.)
 *
 * True for a second entry over the same module — `outlook-readonly` beside
 * `outlook`: the same names, the same credentials, a narrower set. Its
 * `actions` still narrow (every claiming app must allow a shared name), but
 * the IDENTITY question is not its to answer: one credential has one answer,
 * and it is stored on the app that owns the names. `normaliseToolsConfig`
 * refuses `actAs: 'owner'` here out loud rather than storing a field that
 * steers nothing.
 *
 * A degraded index answers `false` — it cannot tell "not one of those" from "I
 * have no list", and `false` only ever means the entry is validated as an
 * ordinary app.
 * @param {string} appId
 */
function appDefersGrants(appId) {
    if (typeof appId !== 'string' || !appId) return false;
    const idx = _index();
    return idx.defersGrants instanceof Set && idx.defersGrants.has(appId);
}

// One line per degraded index, not one per tool call: a broken registry
// touches every tool of every turn, and a log nobody can read is not louder.
let _degradedLoggedFor = null;
/**
 * @param {string} what
 */
function _warnDegraded(what) {
    const idx = _index();
    if (_degradedLoggedFor === idx) return;
    _degradedLoggedFor = idx;
    log.error(`[ToolPolicy] Tool attribution is degraded — ${what}. ` +
        'A grant that cannot be checked is not a grant; fix the tool registry.');
}

module.exports = {
    isAttributionAvailable, appIdForTool, appIdForToolDef, actionsOfApp,
    appRequiresExplicitGrant, appDefersGrants,
    _index, _decidingApps, _warnDegraded, _resetAppIndex,
};

/**
 * A tool definition as far as attribution reads it.
 * @typedef {{ function?: { name?: string }, _mcp?: { serverId?: string }, _custom?: { integrationId?: string, id?: string } }} ToolDef
 */
