/**
 * toolChooserModel: the staged selection of the tool picker, pure (A2 step 4).
 *
 * `toolGrants.js` owns the RULE (unticking writes `{actions: []}`, omitting the key gives the app back).
 * This file owns what the PICKER needs on top of that: what the ticks look like when you open it, what changes
 * while you click, and what exactly is written away on "apply".
 *
 * ── TWO GATES, NOT ONE ──────────────────────────────────────────────
 * An agent may use a tool only if it passes two gates:
 *
 *   `config.enabledIntegrations`  is this APP switched on?      (app level)
 *   `config.tools[app].actions`   which ACTIONS of it?         (action level)
 *
 * The picker shows one tick per action, so it must serve both. Otherwise it can lie in both directions: an app
 * that is switched off would open with ALL ticks on (because without a tools entry "everything" applies), and a
 * ticked action on a switched-off app would do nothing.
 *
 *   opening    an app that is OFF opens with zero ticks, regardless of its grants;
 *   ≥1 tick    the app goes ON and its actions are written;
 *   0 ticks    the app goes OFF AND gets `{actions: []}`. Both refuse, because both narrow. The second one
 *              stays in place if someone later only switches the app list on again.
 *
 * `enabledIntegrations === null` is the LEGACY meaning "everything that is available is on". Materialising that
 * list would be a migration that nobody asked for, so then the app gate stays untouched and only the action gate
 * does its work. Refusing does just as well.
 *
 * ── ONLY WHAT CHANGED IS WRITTEN ────────────────────────────────────
 * `applyAppSelection` writes EVERY app you hand it; that is what it is for. What the picker hands it are the apps
 * whose selection REALLY differs from when it was opened. An app that the owner did nothing to stays unnamed. That
 * is the difference between "he left Drive alone" and "he confirmed Drive", and therefore also the difference
 * between getting into the confirmation regime or not (`hasCuratedGrants` in toolPolicy.js becomes true as soon as
 * one entry exists). A picker that writes everything on opening-and-closing flips that switch without anyone
 * choosing.
 */

import { applyAppSelection, hasCuratedGrants, initialSelection, isAppKey, setAppActions, type SelectionMap, type ToolsConfig } from './toolGrants';
import type { ToolApp } from './toolCatalogTypes';

/**
 * One row per GRANT SUBJECT: two entries over the same module become one.
 *
 * `outlook` and `outlook-readonly` deliver the same tools on the same credentials, and the runtime lets both
 * decide (the strictest wins). If the picker showed them as two separate rows, one tick ADDED could silently
 * remove two from the row next to it: the owner added one read action, lost two other ones, and kept the send
 * action, on a row he did not touch.
 *
 * Which row is the subject follows AVAILABILITY: normally the app that owns the names, but if that one is
 * demonstrably switched off while the narrower variant is on, then the narrower one is the subject. Otherwise
 * the picker would write grants (and an app-level tick) to an app that this user does not have.
 */
export function foldSharedApps(apps: ToolApp[]) {
    const list = (Array.isArray(apps) ? apps : []).filter(a => a && isAppKey(a.id));
    const byId = new Map(list.map(a => [a.id, a]));
    const superseded = new Set<string>();
    for (const app of list) {
        const via = typeof app.grantsVia === 'string' && app.grantsVia ? app.grantsVia : null;
        if (!via) continue;
        const owner = byId.get(via);
        if (!owner) continue;                     // the owner is not shown here
        const narrowWins = owner.available === false && app.available === true;
        superseded.add(narrowWins ? owner.id : app.id);
    }
    return list.filter(a => !superseded.has(a.id));
}

/** Staat deze app aan op app-niveau? Legacy `null` = "alles wat beschikbaar is". */
export function isAppEnabled(enabledIntegrations: string[] | null, appId: string) {
    if (!Array.isArray(enabledIntegrations)) return true;
    return enabledIntegrations.includes(appId);
}

function asSet(value: null): null;
function asSet(value: Set<string> | string[] | undefined): Set<string>;
function asSet(value: Set<string> | string[] | null | undefined): Set<string> | null;
function asSet(value: Set<string> | string[] | null | undefined): Set<string> | null {
    // `null` stays `null` (unknown); everything that is not there is an empty choice.
    if (value === null) return null;
    if (value === undefined) return new Set();
    return value instanceof Set ? new Set(value) : new Set(Array.isArray(value) ? value : []);
}

function sameSet(a: Set<string> | null, b: Set<string> | null) {
    if (a === null || b === null) return a === b;
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

/**
 * The ticks with which the picker OPENS.
 *
 * On top of `initialSelection` (which expands a missing entry to ALL actions, the "no migration" rule) comes
 * the app gate here: if the app is off, nothing is ticked. Unknown actions stay `null`. There is nothing to
 * choose there, and so nothing to write away either.
 */
interface ChooserInitialSelectionArgs {
    toolsConfig?: ToolsConfig | null;
    catalog?: ToolApp[] | null;
    enabledIntegrations?: string[] | null;
    apps?: ToolApp[];
}

export function chooserInitialSelection({
    toolsConfig = null, enabledIntegrations = null, apps = [], catalog = null,
}: ChooserInitialSelectionArgs = {}) {
    // `apps` = the rows that the picker SHOWS (folded); `catalog` = everything the server knows. The second is
    // needed to be able to cut through the shared names: an app that is not shown can still narrow them.
    const expanded = initialSelection(toolsConfig, apps, { catalog });
    const out: SelectionMap = new Map();
    for (const [appId, picked] of expanded) {
        if (picked === null) { out.set(appId, null); continue; }
        out.set(appId, isAppEnabled(enabledIntegrations, appId) ? new Set(picked) : new Set());
    }
    return out;
}

/** De app-ids waarvan de selectie verschilt van de beginstand. */
export function changedAppIds(initial: SelectionMap | null | undefined, current: SelectionMap | null | undefined) {
    const ids: string[] = [];
    const initialMap: SelectionMap = initial instanceof Map ? initial : new Map();
    const currentMap: SelectionMap = current instanceof Map ? current : new Map();
    for (const [appId, before] of initialMap) {
        if (!isAppKey(appId)) continue;
        // Onbekende acties: er valt niets te vergelijken en niets te schrijven.
        if (before === null) continue;
        const after = asSet(currentMap.has(appId) ? currentMap.get(appId) : before);
        if (after === null) continue;
        if (!sameSet(asSet(before), after)) ids.push(appId);
    }
    return ids;
}

/**
 * How many actions come in and how many go out: the text on the button.
 *
 * Two numbers, not a balance: "3 in, 1 out" is something other than "2 in", and a picker that shows only the
 * balance conceals half of what it is doing.
 */
export function selectionDelta(initial: SelectionMap | null | undefined, current: SelectionMap | null | undefined) {
    let added = 0;
    let removed = 0;
    const initialMap: SelectionMap = initial instanceof Map ? initial : new Map();
    const currentMap: SelectionMap = current instanceof Map ? current : new Map();
    for (const [appId, before] of initialMap) {
        if (!isAppKey(appId) || before === null) continue;
        const after = asSet(currentMap.has(appId) ? currentMap.get(appId) : before);
        if (after === null) continue;
        const beforeSet = asSet(before);
        for (const name of after) if (!beforeSet.has(name)) added += 1;
        for (const name of beforeSet) if (!after.has(name)) removed += 1;
    }
    return { added, removed, dirty: added > 0 || removed > 0 };
}

/**
 * The app-level list after the picker: ≥1 tick turns the app on, zero turns it off.
 *
 * Only the apps that CHANGED take part. About the rest nobody said anything, and rewriting a list based on a
 * selection that you did not show is the same kind of silent migration as a grants map that you build from the
 * ticked apps.
 */
function nextEnabledList(enabledIntegrations: string[], changed: string[], selection: SelectionMap | null | undefined) {
    const list = enabledIntegrations.filter(id => typeof id === 'string' && id);
    let enabledChanged = false;
    for (const appId of changed) {
        const picked = asSet(selection instanceof Map ? selection.get(appId) : null);
        if (picked === null) continue;
        const on = picked.size > 0;
        const has = list.includes(appId);
        if (on && !has) { list.push(appId); enabledChanged = true; }
        if (!on && has) { list.splice(list.indexOf(appId), 1); enabledChanged = true; }
    }
    return { list, enabledChanged };
}

/**
 * The FIRST curation changes the meaning of silence. Record what was there before.
 *
 * An app that the picker could never show (`requiresGrant`: the browser, the notebooks, the regex rules) keeps
 * its whole toolbelt for as long as nobody has curated the agent, and gets NOTHING as soon as there is one entry.
 * If the owner narrowed only Gmail, the picker wrote only Gmail, and the agent silently lost its browser, while
 * the screen left the tick on and the button said that nothing was being removed.
 *
 * Therefore: when the map goes from uncurated to curated, every `requiresGrant` app that the picker SHOWED and
 * that the owner did NOT touch gets its current state written out. That removes nothing and adds nothing. It
 * records what was there.
 */
interface _keepRequiresGrantAppsArgs {
    before?: ToolsConfig | null;
    after: ToolsConfig;
    initial?: SelectionMap | null;
    catalog: ToolApp[];
}

function _keepRequiresGrantApps({ before, after, catalog, initial }: _keepRequiresGrantAppsArgs) {
    if (hasCuratedGrants(before) || !hasCuratedGrants(after)) return after;
    let out: ToolsConfig = after;
    for (const app of catalog) {
        if (app.requiresGrant !== true) continue;
        if (out && Object.prototype.hasOwnProperty.call(out, app.id)) continue;
        const picked = initial instanceof Map ? initial.get(app.id) : null;
        if (!(picked instanceof Set)) continue;      // onbekende acties: niets te schrijven
        const names = (Array.isArray(app.actions) ? app.actions : [])
            .map(a => a && a.name).filter(n => typeof n === 'string' && n) as string[];
        const chosen = names.filter(n => picked.has(n));
        out = setAppActions(out, app.id, chosen.length === names.length && names.length > 0 ? '*' : chosen);
    }
    return out;
}

/**
 * What is written on "apply".
 *
 * Yields a NEW config fragment: the grants map and (if it is a list) the app-level list. The caller writes them
 * away in one patch: one save per picker session, not one per tick.
 *
 * @returns {{tools: object, enabledIntegrations: string[]|null, changed: string[],
 *            enabledChanged: boolean}}
 */
interface CommitSelectionArgs {
    toolsConfig?: ToolsConfig | null;
    initial?: SelectionMap | null;
    selection?: SelectionMap | null;
    enabledIntegrations?: string[] | null;
    apps?: ToolApp[];
    catalog?: ToolApp[] | null;
}

export function commitSelection({
    toolsConfig = null,
    enabledIntegrations = null,
    apps = [],
    catalog: fullCatalog = null,
    initial = new Map(),
    selection = new Map(),
}: CommitSelectionArgs = {}) {
    const changed = changedAppIds(initial, selection);
    const shownList = Array.isArray(apps) ? apps.filter(a => a && isAppKey(a.id)) : [];
    const catalog = (Array.isArray(fullCatalog) && fullCatalog.length
        ? fullCatalog.filter(a => a && isAppKey(a.id))
        : shownList);
    const byId = new Map(shownList.map(a => [a.id, a]));
    const shownApps = changed.map(id => byId.get(id)).filter(Boolean) as ToolApp[];
    let tools = applyAppSelection(toolsConfig, { shownApps, selection }, { catalog });
    tools = _keepRequiresGrantApps({ before: toolsConfig, after: tools, catalog: shownList, initial });

    if (!Array.isArray(enabledIntegrations)) {
        // Legacy `null`: de app-poort blijft zoals hij was. Zie de kop.
        return { tools, enabledIntegrations, changed, enabledChanged: false };
    }
    const { list, enabledChanged } = nextEnabledList(enabledIntegrations, changed, selection);
    return { tools, enabledIntegrations: enabledChanged ? list : enabledIntegrations, changed, enabledChanged };
}
