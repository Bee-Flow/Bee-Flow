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
// This index used to swallow a registry failure and hand back an EMPTY one, at
// which point every tool was "unattributed" and every per-action grant matched
// nothing — an agent curated down to `gmail_search` was handed `gmail_compose`
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
        const registry = require('../../../automation/toolRegistry');
        const { ALL_TOOL_APPS } = registry;
        // ── "LOADTOOLS GOOIDE" WAS GEEN SIGNAAL (A2-tegenspraak) ────
        // De echte `loadTools` vangt zijn eigen fout en geeft `[]` terug, dus
        // de catch hieronder ging NOOIT af: een module die niet laadt leverde
        // `byApp.set(app, [])`, `ok` bleef true, en elke naam van die app werd
        // ONGEATTRIBUEERD — de lezing die voor `set_reminder` bedoeld is en die
        // elke per-app-grant passeert. `loadToolsResult` geeft de storing terug
        // als waarde; dat is het verschil tussen "deze app heeft geen tools" en
        // "ik kon deze app niet lezen".
        //
        // Een registry ZONDER die functie (een oudere stub) kan die twee niet
        // uit elkaar houden. Dan is leeg het smalle antwoord: liever een
        // degraded index — waarin een gecureerde agent niets uit het registry
        // krijgt — dan een index die stilzwijgend alles doorlaat.
        const readTools = typeof registry.loadToolsResult === 'function'
            ? (e) => registry.loadToolsResult(e)
            : (e) => { const t = registry.loadTools(e) || []; return { tools: t, ok: t.length > 0 }; };
        for (const entry of ALL_TOOL_APPS || []) {
            if (!entry || !entry.app) continue;
            if (entry.grantsRequireEntry === true) requiresEntry.add(entry.app);
            // ── TWEE ENTRIES, ÉÉN SET NAMEN (A2-4) ──────────────────
            // `outlook` en `outlook-readonly` laden dezelfde module: dezelfde
            // namen, dezelfde credentials, waarvan de tweede een strikte
            // subset levert. Eigendom volgde tot A2-4 de VOLGORDE van het
            // registry ("de eerste wint"), dus bezat `outlook-readonly` geen
            // enkele naam en ging een grant die daarop was opgeslagen nergens
            // over — opslaanbaar en stil dood, precies wat de modulekop
            // verbiedt.
            //
            // Nu wijst het registry de eigenaar AAN (`grantsVia`): een entry
            // die zijn grants elders laat lopen, bezit nooit een naam. Twee
            // rijen omwisselen kan het eigendom dus niet meer verplaatsen — en
            // daarmee ook niet de plek waar de identiteitsvraag (`actAs`)
            // wordt beantwoord.
            const defersTo = typeof entry.grantsVia === 'string' && entry.grantsVia ? entry.grantsVia : null;
            if (defersTo) defersGrants.add(entry.app);
            let res;
            try { res = readTools(entry); } catch (_) { res = null; }
            if (!res || res.ok !== true) { failed.push(entry.app); ok = false; continue; }
            const tools = Array.isArray(res.tools) ? res.tools : [];
            const names = [];
            for (const t of tools) {
                const name = t && t.function && t.function.name;
                if (typeof name !== 'string' || !name) continue;
                names.push(name);
                // Iedereen die de naam LEVERT wordt onthouden, ook de app die
                // hem niet bezit: `isToolAllowed` laat elke claimende app zijn
                // grant uitspreken, zodat de smalste wint.
                if (!claimants.has(name)) claimants.set(name, []);
                const ids = claimants.get(name);
                if (!ids.includes(entry.app)) ids.push(entry.app);
                if (!defersTo && !byTool.has(name)) byTool.set(name, entry.app);
            }
            byApp.set(entry.app, names);
        }
        // Een naam die alleen door uitstellende entries wordt geleverd (de
        // eigenaar ontbreekt of laadde niet) mag niet als ONGEATTRIBUEERD
        // eindigen: dat is de lezing die voor `set_reminder` is bedoeld en die
        // elke per-app-grant zou passeren. De eerste claimende app is dan de
        // eigenaar, en de grants van de rest blijven meebeslissen.
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
            'curated agent is served NO registry tools until it recovers:', e.message);
    }
    if (ok && byTool.size === 0) {
        ok = false;
        log.error('[ToolPolicy] Tool registry produced an empty index — treating attribution as degraded');
    } else if (failed.length) {
        // Precies zeggen wat er gebeurt: de namen van DEZE apps zijn niet meer
        // te attribueren, en een gecureerde agent krijgt die dus niet meer. De
        // apps die wél laadden blijven gewoon door hun eigen grant beslist —
        // dat is geen verbreding (het was daar al zo) en het scheelt een
        // volledige toolbelt bij één kapotte module.
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

/** Every action name an app owns (empty array for an unknown app). */
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
 * De DECLARATIE wordt gelezen voordat de module wordt geladen, dus een app
 * waarvan alleen de tools niet laden staat er nog steeds in — de smalle kant.
 * Een registry die als geheel onleesbaar is levert een lege set en dus `false`;
 * dat verbreedt niets, want de degraded tak in `isToolAllowed` hierboven
 * weigert die namen dan sowieso.
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
 */
function appDefersGrants(appId) {
    if (typeof appId !== 'string' || !appId) return false;
    const idx = _index();
    return idx.defersGrants instanceof Set && idx.defersGrants.has(appId);
}

// One line per degraded index, not one per tool call: a broken registry
// touches every tool of every turn, and a log nobody can read is not louder.
let _degradedLoggedFor = null;
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
