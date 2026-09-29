/**
 * MAY THIS TOOL BE OFFERED? The app-keyed half of the grants map.
 *
 * Which actions an entry grants, what a missing entry means (the no-migration
 * rule), what an UNREADABLE one means (nothing, said out loud), what two apps
 * claiming one name means (both must allow it) — and `hasCuratedGrants`, the
 * opt-in question the whole hold-back hangs on.
 */

'use strict';

const { _plainObject, RESERVED_TOOL_KEYS, GATING_RESERVED_KEYS } = require('./configShape');
const {
    appIdForTool, appIdForToolDef, isAttributionAvailable,
    appRequiresExplicitGrant, _decidingApps, _warnDegraded,
} = require('./appIndex');

/**
 * Which actions of `appId` are granted?
 *
 *   null      → all of them (no entry, or `'*'`) — today's behaviour
 *   Set<name> → exactly these
 *
 * An entry with an empty list yields an EMPTY set, not null: "I picked none"
 * has to survive a round trip, or unticking every action of an app would
 * silently re-grant the whole app.
 *
 * And a value NOBODY CAN READ yields an empty set too, for the same reason
 * `normaliseToolsConfig` turns one into `[]`: "a value nobody can read is not
 * a request for everything". This reader used to answer `null` there — the
 * whole app — so the two readers of one field disagreed about what unreadable
 * means, and only one of them runs at dispatch. On normalised data nothing
 * changes (normalisation only ever emits `'*'` or an array); what it closes is
 * the path where a config reaches this function WITHOUT having been clamped,
 * which is an invariant nothing enforces. Found in the manual review of this
 * layer before A2 — see .claude/handoff/A1B-RECHTENLAAG-REVIEW.md, finding 2.
 */
function allowedToolsFor(appId, toolsConfig) {
    if (!toolsConfig || !appId || RESERVED_TOOL_KEYS.includes(appId)) return null;
    const entry = toolsConfig[appId];
    if (!_plainObject(entry)) return null;
    const actions = entry.actions;
    if (actions === undefined || actions === null || actions === '*') return null;
    if (!Array.isArray(actions)) return new Set();   // unreadable ⇒ nothing granted
    return new Set(actions.filter(a => typeof a === 'string' && a));
}

/**
 * May this tool be offered at all? `tool` is a definition or a bare name.
 *
 * Three different answers used to arrive here as one, and keeping them apart
 * is what A2-1 fixed:
 *
 *   NO APP CLAIMS THIS NAME ⇒ pass. A grant keyed on an app has nothing to say
 *   about `set_reminder`, `activate_skill`, a component tool, or a name built
 *   per user (`automation_<id>`, a reusable Step). That is a deliberate hole in
 *   the *grant* layer, not in the enforcement layer — `buildToolPolicy`'s
 *   allowedToolNames is what closes the stack — and each of those has a gate of
 *   its own (the automations section, the datatables section, the assembly).
 *   MCP and custom tools never reach this branch at all: they carry their own
 *   id on the definition (`appIdForToolDef`).
 *
 *   AN APP CLAIMS IT ⇒ the app's grant decides, and a MISSING entry means every
 *   action of that app. That is the no-migration rule (see the header): the
 *   picker has always been able to show these apps, so the owner saw this one
 *   and left it alone.
 *
 *   TWO APPS CLAIM IT ⇒ both grants decide, and both have to allow it. Two
 *   registry entries can ship the same tool on the same credentials — `outlook`
 *   and `outlook-readonly` do, the second a strict subset of the first. Until
 *   A2-4 the first-listed entry owned the shared names and the other owned
 *   none, so a grant stored on it decided nothing: `{actions: []}` on the
 *   read-only app — "I unticked this entirely" — held back not one call. The
 *   narrow reading is the only one that never widens (see `_decidingApps`).
 *
 *   AN APP CLAIMS IT, BUT THE PICKER COULD NOT SHOW IT ⇒ a curated agent gets
 *   nothing unless its map NAMES the app. `browse_web` is the case this exists
 *   for: registered inline behind a docker probe, in no list the picker reads,
 *   so it arrived here as "nobody claims this name" and sailed past an agent
 *   curated down to `gmail_search` — a full browser nobody granted. Adding it
 *   to the shared list is half the answer; the other half is that silence about
 *   it cannot be read as consent, because nobody was ever ASKED. The apps this
 *   applies to carry `grantsRequireEntry` in automation/toolRegistry.js, the
 *   picker learns it through the catalog's `requiresGrant`, and the moment the
 *   owner touches one the picker writes a real entry — after which the ordinary
 *   rule above takes over.
 *
 * All of that is only safe while "no app claims this name" is something the
 * registry actually SAID. With the index degraded every name looks
 * unattributed, and passing them all would hand an agent curated down to
 * `gmail_search` the whole of Gmail and Drive because a require threw. So for
 * an agent that HAS grants, an unattributable name is refused instead. An
 * agent without grants is unaffected (the first line returns).
 */
function isToolAllowed(tool, toolsConfig) {
    if (!toolsConfig) return true;
    const isDef = _plainObject(tool);
    const name = isDef ? (tool.function && tool.function.name) : tool;
    if (typeof name !== 'string' || !name) return false;   // unnameable ⇒ never offered
    const appId = isDef ? appIdForToolDef(tool) : appIdForTool(name);
    if (!appId) {
        if (isAttributionAvailable()) return true;
        // An empty or junk-only map is not a curation (hasCuratedGrants), and
        // there is no picked list to protect there — treat it like no map at
        // all, exactly as the healthy path does.
        if (!hasCuratedGrants(toolsConfig)) return true;
        _warnDegraded(`refusing "${name}" for an agent with stored grants`);
        return false;
    }
    // Meestal precies één app; twee registry-entries die dezelfde tool leveren
    // beslissen allebei, en dan moet ELK van hen toestaan (zie `_decidingApps`).
    return _decidingApps(appId, name).every(id => _appAllowsTool(id, name, toolsConfig));
}

/**
 * Het oordeel van ÉÉN app over één van zijn eigen toolnamen.
 *
 * ── EEN ENTRY IS NOG GEEN ACTIEKEUZE (A2-tegenspraak) ───────────────
 * Deze functie las tot nu toe ELKE entry-die-een-object-is als "de eigenaar
 * noemde deze app, dus hij bedoelde alles". Voor een `grantsRequireEntry`-app
 * is dat een verbreding van NIETS naar ALLES, en de kaart schrijft precies
 * zulke entries: "Confirm first" aanzetten (`setAppConfirm`) of de Als-capsule
 * omzetten (`setAppActAs`) zette `{confirm}` respectievelijk `{actAs}` neer,
 * ZONDER `actions`. Twee versmallende gebaren gaven zo een volledige headless
 * browser aan een agent die tot `gmail_search` was gecureerd — en normalisatie
 * schreef er `actions: '*'` bij in de rij.
 *
 * Voor zo'n app telt daarom alleen een UITGESCHREVEN keuze: een actielijst, of
 * een expliciete `'*'`. Een ontbrekende (of onleesbare) `actions` is "er staat
 * niets", en niets is bij deze apps geen ja — niemand kreeg ze ooit te zien.
 * Voor elke gewone app blijft de geen-migratieregel onaangeroerd.
 */
function _appAllowsTool(appId, name, toolsConfig) {
    const allowed = allowedToolsFor(appId, toolsConfig);
    if (allowed !== null) return allowed.has(name);
    // `null` = "every action". Voor een app die de picker altijd al kon tonen
    // is dat de geen-migratieregel: de eigenaar zag hem en liet hem staan.
    if (!appRequiresExplicitGrant(appId)) return true;
    const entry = toolsConfig[appId];
    if (_plainObject(entry) && entry.actions === '*') return true;
    return !hasCuratedGrants(toolsConfig);
}

/**
 * Has anyone actually curated this agent's tools? The opt-in question that
 * `buildToolPolicy` hangs the whole hold-back on.
 *
 * The MAP is the opt-in, but only when it holds something a person could have
 * picked. Two shapes look like a map and are not a choice:
 *
 *   `{}`                 what a malformed `tools` value normalises to, and
 *                        what an empty section leaves behind;
 *   `{ gmail: 'nope' }`  a junk entry — every reader here requires a plain
 *                        object, so it grants nothing and asks nothing.
 *
 * Counting either as "someone has been through the picker" flips the agent
 * into the confirmation regime by accident, and an unattended run then drops
 * its send tools entirely: a mailing routine that silently stops mailing, with
 * nothing in the picker to explain why. One bad PUT — or one MCP/restore patch
 * — is enough to reach it, so the question is asked of the CONTENTS.
 *
 * And only of the contents that GATE something. A reserved section counts when
 * it grants something AND something enforces it: `automations` narrows the
 * routines an agent is offered, and `datatables` narrows which tables
 * `datatable_query` reads, whose rows and which columns.
 *
 * `datatables` was NOT on that list until A1c, and the reason is worth keeping:
 * for two releases nothing enforced it, and counting it anyway was an accident
 * by another door — `{datatables:{t1:{}}}` flipped every send tool of the agent
 * to `ask` (unattended: out of the stack entirely) on the strength of a section
 * that changed nothing about what ran. The test is "does something enforce it",
 * never "is it in RESERVED_TOOL_KEYS": a section added here without an
 * enforcement site has to stay off GATING_RESERVED_KEYS.
 */
function hasCuratedGrants(toolsConfig) {
    if (!_plainObject(toolsConfig)) return false;
    for (const [key, entry] of Object.entries(toolsConfig)) {
        if (!_plainObject(entry)) continue;                     // junk: grants nothing
        if (!RESERVED_TOOL_KEYS.includes(key)) return true;     // an app entry
        if (!GATING_RESERVED_KEYS.includes(key)) continue;      // reserved, but gates nothing
        if (Object.keys(entry).length > 0) return true;         // at least one grant
    }
    return false;
}

module.exports = { allowedToolsFor, isToolAllowed, hasCuratedGrants };
