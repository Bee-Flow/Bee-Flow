/**
 * toolGrants: the GRANTS CONTRACT of the Tools card, pure (A2 step 3).
 *
 * Here stands the one rule that this whole stage revolves around. It stands here because it may stand nowhere else:
 * the card and the picker both write to `config.tools`, and a second place where that happens is a second place where
 * it can be forgotten.
 *
 * ── THE RULE ────────────────────────────────────────────────────────
 * An app that the map does NOT mention keeps its FULL tool belt.
 *
 * That is deliberate. It is the "no migration" rule of `server/core/agentRuntime/toolPolicy.js`: every agent from before
 * the picker keeps its tools without a data migration. The consequence is precisely the reverse of what you would expect:
 *
 *   unticking an app  ⇒  WRITE `{ actions: [] }`
 *   omitting the key  ⇒  give back the WHOLE app
 *
 * So the map must NEVER be built from only the ticked apps. Whoever writes `Object.fromEntries(selected.map(...))` gives
 * every unticked app everything back, in silence. The same trap already caught the automations section: "untick all
 * automations" yielded ALL automations, because the empty section was thrown away and afterwards read as "never chosen".
 * See `.claude/handoff/A1B-RECHTENLAAG-REVIEW.md`, finding 1.
 *
 * ── THE OTHER HALF OF THE SAME TRAP ────────────────────────────────
 * The initial selection of the picker must expand a MISSING entry to ALL actions of that app. If it does not, an agent
 * from before the picker opens with zero ticks while in reality it may do everything, and the first save takes
 * everything from it without anyone unticking anything. `initialSelection` does that; `applyAppSelection` is its
 * counterpart.
 *
 * ── WHAT IS NOT IN HERE ─────────────────────────────────────────────
 * Sentences. These are facts and mutations. The text is in `ToolsCard.jsx`, where the literal `t()` keys that the
 * i18n guard reads also stand.
 */

import { isAgentCallable } from '../../../admin/Studio/SkillsStudio/skillModel';
import { READ } from './canUseFacts';
import type { ToolApp } from './toolCatalogTypes';
import type { CallableAutomation } from '../../../admin/Studio/SkillsStudio/skillModel.types';
import type { AutomationLike, ToolsConfig, ToolsConfigIn, SelectionMap, ToolRowsArgs, AutomationRowsArgs } from './toolGrants.types';
import { UNSAFE_OBJECT_KEYS, CONFIRM, ACT_AS, isPlainObject, uniqueStrings, isAppKey, grantedActionsOf, claimantsOf, effectiveActionsOf, hasCuratedGrants, cloneTools, toolRow } from './toolGrants.helpers';
;
export type { AutomationLike, ToolsConfig, SelectionMap } from './toolGrants.types';

// ── Twee rijen over dezelfde module ─────────────────────────────────

/**
 * Write the actions of one app.
 *
 * `actions` is `'*'` (the whole app) or a list. AN EMPTY LIST IS STORED: that is the whole contract.
 * `delete out[appId]` does not belong here and must never come to stand here, because that gives the app back.
 */
export function setAppActions(toolsConfig: ToolsConfigIn, appId: string, actions: string | (string | undefined)[]) {
    if (!isAppKey(appId)) return isPlainObject(toolsConfig) ? cloneTools(toolsConfig) : {};
    const out = cloneTools(toolsConfig);
    const prev: Record<string, unknown> = isPlainObject(out[appId]) ? out[appId] : {};
    const next: Record<string, unknown> = { ...prev };
    next.actions = actions === '*' ? '*' : uniqueStrings(actions);
    out[appId] = next;
    return out;
}

/**
 * Write the confirmation policy of one app.
 *
 * The ACTIONS stay as they were, also if there was no entry yet. Then a missing `actions` still means "the whole
 * app". Nothing is taken away here; a choice is added.
 */
export function setAppConfirm(toolsConfig: ToolsConfigIn, appId: string, confirm: string, { requiresGrant = false } = {}) {
    if (!isAppKey(appId) || (confirm !== CONFIRM.DIRECT && confirm !== CONFIRM.ASK)) {
        return cloneTools(toolsConfig);
    }
    const out = cloneTools(toolsConfig);
    out[appId] = { ..._entryKeepingActions(toolsConfig, appId, requiresGrant), confirm };
    return out;
}

/**
 * The entry of an app, with its CURRENT actions written out.
 *
 * Setting an entry must not silently add or remove actions, and it used to: `{confirm}` or `{actAs}` written without
 * `actions` turned "the owner said nothing about this app" into an entry. For an app that the picker could never show
 * (`requiresGrant`), that means the difference between NOTHING and ALL: two narrowing gestures on the card gave a full
 * headless browser to a curated agent. By writing the actions out explicitly, the entry afterwards means exactly what
 * the row showed before.
 */
function _entryKeepingActions(toolsConfig: ToolsConfigIn, appId: string, requiresGrant: boolean): Record<string, unknown> {
    const prev: Record<string, unknown> = isPlainObject(toolsConfig) && isPlainObject(toolsConfig[appId]) ? toolsConfig[appId] : {};
    if (prev.actions === '*' || Array.isArray(prev.actions)) return { ...prev };
    const granted = grantedActionsOf(toolsConfig, appId, { requiresGrant });
    return { ...prev, actions: granted === '*' ? '*' : [...granted] };
}

/**
 * Write "in whose name" for one app.
 *
 * `null` REMOVES the choice instead of making it `viewer`. That is the difference between "the owner chose the asker"
 * and "the owner chose nothing", and `mayLendOwnerConnection` reads that difference: only a STORED `actAs` decides
 * there, and a missing one leaves the default in place.
 */
export function setAppActAs(toolsConfig: ToolsConfigIn, appId: string, actAs: string | null, { requiresGrant = false } = {}) {
    if (!isAppKey(appId)) return cloneTools(toolsConfig);
    const out = cloneTools(toolsConfig);
    // Same reason as with `setAppConfirm`: setting an entry must not change the actions, so they go along explicitly.
    const next = _entryKeepingActions(toolsConfig, appId, requiresGrant);
    if (actAs === ACT_AS.OWNER || actAs === ACT_AS.VIEWER) next.actAs = actAs;
    else delete next.actAs;
    out[appId] = next;
    return out;
}

/**
 * The initial selection of the picker: which actions are ON today?
 *
 * An app without an entry gets ALL its actions, because that is what it may do today. Without this expansion the
 * picker would open an agent from before A1b with zero ticks, and the first save would take everything from it: a
 * "migration" that nobody asked for and nobody sees.
 *
 * An app whose actions we do NOT know (the catalogue lacks it, or its module did not load) yields `null`. That is
 * not "no actions", and the caller may therefore not make a selection of it either.
 *
 * An app with `requiresGrant` opens with zero ticks on a CURATED agent: there a missing entry is not "everything" but
 * "nothing" (see `grantedActionsOf`). Without that second half the picker would show ticks that the runtime does not
 * honour, and `commitSelection` writes only what CHANGED, so those ticks would never become a real grant.
 *
 * @param {object|null} toolsConfig
 * @param {Array<{id: string, actions?: Array<{name: string}>, actionsKnown?: boolean,
 *                requiresGrant?: boolean}>} apps
 * @returns {Map<string, Set<string>|null>} per app id the ticked actions
 */
export function initialSelection(toolsConfig: ToolsConfigIn, apps: ToolApp[], { catalog = null }: { catalog?: ToolApp[] | null } = {}) {
    const out: SelectionMap = new Map();
    const list = Array.isArray(apps) ? apps : [];
    // The intersection is made against the FULL catalogue, even if the picker shows only one row per grant subject. An
    // app that is not in view here can still narrow the names, and then the picker opens with ticks that refuse at dispatch.
    const full = Array.isArray(catalog) && catalog.length ? catalog : list;
    const claimants = claimantsOf(full);
    for (const app of list) {
        if (!app || !isAppKey(app.id)) continue;
        if (app.actionsKnown === false) { out.set(app.id, null); continue; }
        // The EFFECTIVE reading: if a second app supplies the same names, its grant counts too (the runtime does that as
        // well). Otherwise the picker opens with ticks that refuse at dispatch.
        const { names } = effectiveActionsOf(toolsConfig, app, { apps: full, claimants });
        out.set(app.id, new Set(names || []));
    }
    return out;
}

/**
 * The picker commits: write the selection of EVERY app shown.
 *
 * `shownApps` is the list of apps that the picker has SHOWN. Every app in it gets an entry, including the app where
 * nothing is on, because that very entry is the unticking. An app that the picker did not show (not available for
 * this user, or filtered away) stays UNTOUCHED: nobody said anything about that app, and writing a refusal for it
 * would invent a choice.
 *
 * An app whose actions are unknown (`actionsKnown === false`, or `selection.get(id) === null`) also stays untouched:
 * you cannot write down what is on when you do not know what there is.
 *
 * @param {object|null} toolsConfig
 * @param {{shownApps: Array<{id: string, actions?: Array<{name: string}>, actionsKnown?: boolean}>,
 *          selection: Map<string, Set<string>|Array<string>|null>}} p
 */
export function applyAppSelection(toolsConfig: ToolsConfigIn, { shownApps = [], selection = new Map() }: { shownApps?: ToolApp[]; selection?: SelectionMap | Record<string, Set<string> | null> | null } = {}, { catalog = null }: { catalog?: ToolApp[] | null } = {}) {
    let out = cloneTools(toolsConfig);
    const get = (id: string) => (selection instanceof Map ? selection.get(id) : (selection || {})[id]);
    const shown = Array.isArray(shownApps) ? shownApps : [];
    const shownIds = new Set(shown.map(a => a && a.id));
    for (const app of shown) {
        if (!app || !isAppKey(app.id)) continue;
        if (app.actionsKnown === false) continue;
        const picked = get(app.id);
        if (picked === null || picked === undefined) continue;
        const names = uniqueStrings((app.actions || []).map(a => a && a.name));
        const chosen = uniqueStrings([...picked]).filter(n => names.includes(n));
        // ALL ticked becomes `'*'`, not the written-out list. Then the app inherits an action that comes in with the next
        // release, instead of missing it silently. That is the intended meaning of `'*'` (toolPolicy.js: "inherit on
        // `'*'`, opt-in on a list").
        const allOn = names.length > 0 && chosen.length === names.length;
        out = setAppActions(out, app.id, allOn ? '*' : chosen);
        out = _syncSharedSiblings(out, app, chosen, catalog, shownIds);
    }
    return out;
}

/**
 * Keep the entries of apps that supply the SAME tool names in step.
 *
 * The runtime lets every supplying app take part in the decision, so a ticked name that another (not shown) app refuses
 * is a dead tick: savable, and silently without effect, exactly what this layer forbids. Only the SHARED names are
 * brought into line. What such an app supplies exclusively stays as it was, and an app that the map does not mention is
 * not mentioned either (it narrows nothing, and inventing an entry for it would invent a choice).
 */
function _syncSharedSiblings(out: ToolsConfig, app: ToolApp, chosen: string[], catalog: ToolApp[] | null, shownIds: Set<string>) {
    if (!Array.isArray(catalog) || !catalog.length) return out;
    const mine = uniqueStrings((app.actions || []).map(a => a && a.name));
    let next = out;
    for (const sib of catalog) {
        if (!sib || !isAppKey(sib.id) || sib.id === app.id) continue;
        if (shownIds && shownIds.has(sib.id)) continue;      // die spreekt voor zichzelf
        if (!isPlainObject(next[sib.id])) continue;          // niet genoemd = alles = versmalt niet
        if (sib.actionsKnown === false || !Array.isArray(sib.actions)) continue;
        const sibNames = uniqueStrings(sib.actions.map(a => a && a.name));
        const shared = sibNames.filter(n => mine.includes(n));
        if (!shared.length) continue;
        const prev = grantedActionsOf(next, sib.id, { requiresGrant: sib.requiresGrant === true });
        const keep = (prev === '*' ? sibNames : prev).filter(n => !shared.includes(n));
        const merged = uniqueStrings([...keep, ...chosen.filter(n => sibNames.includes(n))]);
        next = setAppActions(next, sib.id, merged.length === sibNames.length ? '*' : merged);
    }
    return next;
}

/**
 * The FIRST curation changes the meaning of SILENCE. Record what was there.
 *
 * As long as nobody has curated the agent, an app that the picker could never show (`requiresGrant`: the browser, the
 * notebooks, the regex rules) keeps its whole toolbelt. As soon as there is ONE entry, it gets nothing. That is
 * deliberate (nobody ever saw those apps, so silence is no choice), but it must not happen as a side effect of a click
 * on another row. "Confirm first" on Gmail would otherwise silently take away the browser.
 *
 * Therefore: when the map goes from uncurated to curated, every `requiresGrant` app that does not yet have an entry gets
 * its CURRENT state written out. That removes nothing and adds nothing.
 *
 * `enabledIntegrations` counts too, because the app-level list is the first gate: an app that is OFF there stays off.
 * Giving it `'*'` here would store a grant that becomes real the moment someone switches that list on.
 */
export function keepRequiresGrantApps(before: ToolsConfigIn, after: ToolsConfigIn, { apps = null, enabledIntegrations = null }: { apps?: ToolApp[] | null; enabledIntegrations?: string[] | null } = {}) {
    if (!isPlainObject(after)) return after;
    if (hasCuratedGrants(before) || !hasCuratedGrants(after)) return after;
    let out = after;
    for (const app of Array.isArray(apps) ? apps : []) {
        if (!app || !isAppKey(app.id) || app.requiresGrant !== true) continue;
        if (Object.prototype.hasOwnProperty.call(out, app.id)) continue;
        const appOn = !Array.isArray(enabledIntegrations) || enabledIntegrations.includes(app.id);
        const granted = appOn ? grantedActionsOf(before, app.id, { requiresGrant: true }) : [];
        out = setAppActions(out, app.id, granted === '*' ? '*' : [...granted]);
    }
    return out;
}

// ── De rijen van de Tools-kaart ─────────────────────────────────────

export function toolRows({
    toolsConfig = null,
    enabledIntegrations = [],
    apps = null,
    catalogState = READ.OK,
    providersKnown = false,
    labels = null,
    lentApps = null,
    lendingEnabled = false,
    runtimeCurated = undefined,
}: ToolRowsArgs = {}) {
    const labelOf = (id: string) => {
        if (labels instanceof Map) return labels.get(id) || null;
        if (labels && typeof labels === 'object' && typeof labels[id] === 'string') return labels[id];
        return null;
    };
    const byId = new Map<string, ToolApp>();
    if (catalogState === READ.OK && Array.isArray(apps)) {
        for (const app of apps) {
            if (app && isAppKey(app.id)) byId.set(app.id, { ...app });
        }
    }
    // `providersKnown` is a property of the ANSWER, not of one app. It travels along on every row so that `toolRow` can
    // stay pure.
    const known = catalogState === READ.OK && !!providersKnown;
    // Likewise for the curation: a property of the AGENT, calculated once.
    //
    // The lending notices make a claim about what the RUNTIME does, and that reads `published_config`, not the draft that
    // is in hand here. One tick in the picker made the draft curated, and the card immediately reported that no more was
    // being lent, while the published agent was still lending as before. Therefore the answer of the server counts
    // (`runtimeCurated` from GET /agents/:id/tool-lending). `null`/unknown says nothing, because a reassurance that is not
    // correct is worse than no sentence.
    const curated = runtimeCurated === undefined ? hasCuratedGrants(toolsConfig) : runtimeCurated;
    // Wie levert welke toolnaam — één keer voor alle rijen.
    const claimants = claimantsOf(catalogState === READ.OK && Array.isArray(apps) ? apps : []);

    const ids: string[] = [];
    const push = (id: string) => { if (isAppKey(id) && !ids.includes(id)) ids.push(id); };
    if (Array.isArray(enabledIntegrations)) {
        for (const id of enabledIntegrations) push(id);
    } else if (byId.size > 0) {
        // Legacy `null`: everything that is available is on. "Available" is a question that only the catalogue answers, and an app
        // whose status is unknown (`available === null`) we count along. Leaving it out would claim that the agent does not
        // have it.
        for (const [id, app] of byId) if (app.available !== false) push(id);
    }
    for (const key of Object.keys(isPlainObject(toolsConfig) ? toolsConfig : {})) push(key);

    const catalog = catalogState === READ.OK && Array.isArray(apps) ? apps : [];
    return ids.map(appId => toolRow({
        appId,
        label: byId.get(appId)?.label || labelOf(appId),
        toolsConfig,
        app: byId.has(appId) ? { ...(byId.get(appId) as ToolApp), providersKnown: known } : null,
        lentApps,
        lendingEnabled,
        curated,
        apps: catalog,
        claimants,
    }));
}

// ── Automations als tool ────────────────────────────────────────────

/** De gegunde automatiseringen uit `config.tools.automations`, in configvolgorde. */
export function automationGrantsOf(toolsConfig: ToolsConfigIn) {
    if (!isPlainObject(toolsConfig) || !isPlainObject(toolsConfig.automations)) return [];
    return Object.keys(toolsConfig.automations)
        .filter(id => !UNSAFE_OBJECT_KEYS.has(id))
        .map((id) => {
            const g = (toolsConfig.automations as Record<string, unknown>)[id];
            // Mirror of normaliseToolsConfig: a confirm that nobody can read is NOT "no confirmation". Unreadable ⇒ `ask`.
            const confirm = isPlainObject(g) && (g.confirm === CONFIRM.DIRECT || g.confirm === CONFIRM.ASK)
                ? g.confirm
                : (isPlainObject(g) && g.confirm === undefined ? CONFIRM.DIRECT : CONFIRM.ASK);
            return { id, confirm };
        });
}

/**
 * The parameter pills of an automation: the fields that the agent has to pass along.
 *
 * From `trigger.parametersSchema`, the same schema from which `automationToTool` renders the tool signature. So what
 * appears on the screen here is literally what the model has to fill in. Required fields first.
 */
export function paramPillsOf(automation: AutomationLike | null | undefined) {
    const schema = automation?.definition?.trigger?.parametersSchema
        ?? automation?.trigger?.parametersSchema
        ?? null;
    if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
    const required = new Set(uniqueStrings(schema.required));
    return Object.keys(schema.properties)
        .filter(name => !UNSAFE_OBJECT_KEYS.has(name))
        .map(name => ({ name, required: required.has(name) }))
        .sort((a, b) => Number(b.required) - Number(a.required));
}

export function automationRows({ toolsConfig, automations, state = READ.OK, linkedIds = null }: AutomationRowsArgs) {
    const linked = linkedIds ? new Set(linkedIds) : null;
    const grants = automationGrantsOf(toolsConfig);
    const index = state === READ.OK && Array.isArray(automations) ? new Map(
        automations.filter(a => a && typeof a.id === 'string').map(a => [a.id, a]),
    ) : null;
    return grants.map(({ id, confirm }) => {
        const automation = index ? index.get(id) : null;
        if (!automation) {
            return { id, name: null, confirm, params: [], callable: null, linked: linked ? linked.has(id) : null, readable: false };
        }
        return {
            id,
            name: typeof automation.title === 'string' && automation.title
                ? automation.title
                : (typeof automation.name === 'string' && automation.name ? automation.name : null),
            confirm,
            params: paramPillsOf(automation),
            callable: isAgentCallable(automation),
            linked: linked ? linked.has(id) : null,
            readable: true,
        };
    });
}
