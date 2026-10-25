import type { ToolApp } from './toolCatalogTypes';
import type { ToolsConfig, ToolsConfigIn, ClaimantsIndex, LendingNoticeOfArgs, ToolRowArgs } from './toolGrants.types';

const RESERVED_TOOL_KEYS = Object.freeze(['automations', 'datatables']);

/** Keys that a plain object cannot safely carry (mirror of toolPolicy.js). */
export const UNSAFE_OBJECT_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

export const CONFIRM = Object.freeze({ DIRECT: 'direct', ASK: 'ask' });

export const ACT_AS = Object.freeze({ VIEWER: 'viewer', OWNER: 'owner' });

/**
 * In whose name an app runs, as a QUESTION and not as an answer.
 *
 *   USER      the app borrows a user connection (Gmail, Drive, YouTrack).
 *             Only here does "in whose name" have meaning, and only here is `actAs` stored.
 *   PLATFORM  the app has no user connection: websearch, built-in tools, platform services.
 *             Static "As: Bee Flow", no choice, and NO `actAs` in the config. A stored choice that
 *             steers nothing is exactly what toolPolicy.js forbids.
 *   UNKNOWN   we could not ask. That is not PLATFORM, because that would draw an app that DOES borrow
 *             credentials as "Bee Flow".
 */
export const ACT_AS_KIND = Object.freeze({ USER: 'user', PLATFORM: 'platform', UNKNOWN: 'unknown' });

export function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Only non-empty strings, unique, in order. */
export function uniqueStrings(list: unknown) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of Array.isArray(list) ? list : []) {
        if (typeof s !== 'string' || !s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/** Is this an app key (and not a reserved section or something dangerous)? */
export function isAppKey(key: unknown): key is string {
    return typeof key === 'string' && !!key
        && !RESERVED_TOOL_KEYS.includes(key)
        && !UNSAFE_OBJECT_KEYS.has(key);
}

/**
 * The granted actions of one app: `'*'` (everything) or a list.
 *
 * An exact mirror of `allowedToolsFor` in toolPolicy.js, including the narrowing that has been there since A1c: an
 * `actions` that nobody can read is NOT a request for everything, so it becomes `[]`. A MISSING entry stays `'*'`.
 * That is the "no migration" rule, and it is something quite different.
 *
 * `requiresGrant` (from the catalogue, `app.requiresGrant`) is the exception that A2-1 added: for an app that the
 * picker could NEVER show, silence means nothing rather than everything. See the block in the function.
 */
export function grantedActionsOf(toolsConfig: ToolsConfigIn, appId: string | null | undefined, { requiresGrant = false } = {}) {
    if (!isPlainObject(toolsConfig) || !isAppKey(appId)) return '*';
    const entry = toolsConfig[appId];
    if (!isPlainObject(entry)) {
        // No entry ⇒ everything (the rule). An entry that is not an object ⇒ the server makes `{actions: []}` of it, so
        // that is what should stand here. Otherwise the card would show "everything" for a grant that the runtime
        // narrows to nothing.
        if (entry !== undefined) return [];
        // ...EXCEPT for an app that the picker could never show (`requiresGrant` from the catalogue; `browse_web` and the
        // other inline registered tools). Silence is not a choice there: nobody ever got to see that app, so "the owner
        // left it alone" cannot be true. The server reads it that way (toolPolicy.isToolAllowed → appRequiresExplicitGrant),
        // and without this mirror the picker opens with ticks on that the runtime refuses. Only for a CURATED agent:
        // without curation the rights layer does not even look at the map, and then the app may really do everything.
        return requiresGrant && hasCuratedGrants(toolsConfig) ? [] : '*';
    }
    const { actions } = entry;
    if (actions === '*') return '*';
    if (actions === undefined || actions === null) {
        // An entry WITHOUT an action list. For an ordinary app that is still "everything" (the no-migration rule), but for an
        // app that the picker could never show it is not: there only a WRITTEN-OUT choice is a permission. The card itself
        // writes such entries (`setAppConfirm` and `setAppActAs` write `{confirm}` and `{actAs}` respectively), so without
        // this mirror the card would show ticks that the runtime refuses (server/core/agentRuntime/toolPolicy.js `_appAllowsTool`).
        return requiresGrant && hasCuratedGrants(toolsConfig) ? [] : '*';
    }
    if (!Array.isArray(actions)) return [];
    return uniqueStrings(actions);
}

/**
 * Who SUPPLIES which tool name? `name → [appId, …]`, from the catalogue.
 *
 * Two registry entries can deliver the same tools on the same credentials (`outlook` and `outlook-readonly`), and
 * the runtime then lets EVERY supplying app speak its grant: the strictest wins (toolPolicy.js `_decidingApps`).
 * The card knew nothing about that and counted per row only its own entry, so it reported four ticked actions
 * where the runtime serves one.
 */
export function claimantsOf(apps: ToolApp[]) {
    const out: ClaimantsIndex = new Map();
    for (const app of Array.isArray(apps) ? apps : []) {
        if (!app || !isAppKey(app.id) || !Array.isArray(app.actions)) continue;
        for (const a of app.actions) {
            const name = a && a.name;
            if (typeof name !== 'string' || !name) continue;
            if (!out.has(name)) out.set(name, []);
            const ids = out.get(name);
            if (!ids?.includes(app.id)) ids?.push(app.id);
        }
    }
    return out;
}

/**
 * The actions of one app that the runtime ACTUALLY honours.
 *
 * The own grant, intersected with that of every other app that supplies the same name: exactly what
 * `isToolAllowed` does. Without a catalogue there is nothing to intersect, and the answer is the own grant.
 *
 * @returns {{names: string[]|null, narrowedBy: string[]}} `names: null` = the actions of this app are unknown,
 *   and then there is nothing to show.
 */
export function effectiveActionsOf(toolsConfig: ToolsConfigIn, app: ToolApp | null, { apps = null, claimants = null }: { apps?: ToolApp[] | null; claimants?: ClaimantsIndex | null } = {}) {
    const known = !!app && app.actionsKnown !== false && Array.isArray(app.actions);
    const granted = grantedActionsOf(toolsConfig, app && app.id, {
        requiresGrant: !!(app && app.requiresGrant),
    });
    if (!known) return { names: granted === '*' ? null : granted, narrowedBy: [] };

    const own = uniqueStrings(app.actions?.map(a => a && a.name));
    const mine = granted === '*' ? own : own.filter(n => granted.includes(n));
    const index = claimants instanceof Map ? claimants : claimantsOf(apps || []);
    const byId = new Map((Array.isArray(apps) ? apps : []).map(a => [a && a.id, a]));

    const narrowedBy: string[] = [];
    const names = mine.filter((name) => {
        const ids = index.get(name);
        if (!Array.isArray(ids) || ids.length < 2) return true;
        for (const id of ids) {
            if (id === app.id) continue;
            const other = byId.get(id);
            const g = grantedActionsOf(toolsConfig, id, { requiresGrant: !!(other && other.requiresGrant) });
            if (g === '*' || g.includes(name)) continue;
            if (!narrowedBy.includes(id)) narrowedBy.push(id);
            return false;
        }
        return true;
    });
    return { names, narrowedBy };
}

/**
 * Does this agent already have a CURATED map? Mirror of `hasCuratedGrants` in toolPolicy.js (r569).
 *
 * This is the opt-in boundary of the whole mechanism. As long as the answer is `false`, the runtime does not even
 * look at the map: no confirmation regime, no `enforceNames`. The FIRST entry switches that over, and that is a
 * noticeable change of behaviour for an agent that today runs unattended. The picker may therefore not let it
 * happen silently; it says so out loud before the first save.
 *
 * Junk does not count (an entry that is not an object grants nothing), and an EMPTY reserved section does not
 * either, precisely as the server reads it.
 */
export function hasCuratedGrants(toolsConfig: ToolsConfigIn) {
    if (!isPlainObject(toolsConfig)) return false;
    for (const [key, entry] of Object.entries(toolsConfig)) {
        if (UNSAFE_OBJECT_KEYS.has(key) || !isPlainObject(entry)) continue;
        if (!RESERVED_TOOL_KEYS.includes(key)) return true;
        if (Object.keys(entry).length > 0) return true;
    }
    return false;
}

/** The stored `confirm` of an app, or `null` if there is no choice. */
function storedConfirmOf(toolsConfig: ToolsConfigIn, appId: string) {
    const entry = isPlainObject(toolsConfig) ? toolsConfig[appId] : null;
    if (!isPlainObject(entry)) return null;
    return entry.confirm === CONFIRM.DIRECT || entry.confirm === CONFIRM.ASK ? entry.confirm : null;
}

/** The stored `actAs` of an app, or `null` if there is no choice. */
function storedActAsOf(toolsConfig: ToolsConfigIn, appId: string) {
    const entry = isPlainObject(toolsConfig) ? toolsConfig[appId] : null;
    if (!isPlainObject(entry)) return null;
    return entry.actAs === ACT_AS.OWNER || entry.actAs === ACT_AS.VIEWER ? entry.actAs : null;
}

/** Een kopie van de map, met de gereserveerde secties intact. */
export function cloneTools(toolsConfig: ToolsConfigIn) {
    const out: ToolsConfig = {};
    if (!isPlainObject(toolsConfig)) return out;
    for (const [key, value] of Object.entries(toolsConfig)) {
        if (UNSAFE_OBJECT_KEYS.has(key)) continue;
        out[key] = value;
    }
    return out;
}

/**
 * Does this app send something, given what is granted?
 *
 * `true` / `false` / `null`, and `null` is not "no". Without a catalogue we do not know what an action does, and then the
 * narrow reading is the only honest one: the card locks on "confirm first". That is exactly what `normaliseToolsConfig`
 * does when the attribution is broken: unknown counts as "it sends".
 */
export function sendsFor(granted: '*' | (string | undefined)[] | null, app: ToolApp | null) {
    if (!app || app.actionsKnown === false || !Array.isArray(app.actions)) return null;
    const relevant = granted === '*'
        ? app.actions
        : app.actions.filter(a => a && (granted as (string | undefined)[]).includes(a.name));
    if (relevant.some(a => a && a.effect === 'sends')) return true;
    // An action without an effect field is an action whose effect we do not know. One of those makes the answer
    // unknown for the whole app.
    if (relevant.some(a => !a || typeof a.effect !== 'string' || !a.effect)) return null;
    return false;
}

function lendingNoticeOf({ actAsKind, appId, lentApps, lendingEnabled, curated, storedActAs }: LendingNoticeOfArgs) {
    const lendable = actAsKind === ACT_AS_KIND.USER && !!lendingEnabled
        && lentApps instanceof Set && lentApps.has(appId);
    if (curated !== true && curated !== false) return { ownerLendsUncurated: false, ownerLendingUnset: false };
    return {
        ownerLendsUncurated: lendable && !curated,
        ownerLendingUnset: lendable && curated && storedActAs === null,
    };
}

export function toolRow({
    appId, label, toolsConfig, app, lentApps, lendingEnabled, curated = false,
    apps = null, claimants = null,
}: ToolRowArgs) {
    const granted = grantedActionsOf(toolsConfig, appId, { requiresGrant: !!(app && app.requiresGrant) });
    const known = !!app && app.actionsKnown !== false && Array.isArray(app.actions);
    const totalActions = known ? app.actions?.length : null;
    // What the RUNTIME serves, not what this one entry says: if a second app supplies the same names, that one must allow
    // it too (toolPolicy `_decidingApps`). Without that intersection the row counted four ticked actions where one runs.
    // That is over-reporting, precisely the direction that this layer forbids.
    const { names: effective, narrowedBy } = effectiveActionsOf(toolsConfig, app, { apps, claimants });
    const grantedNames = known ? effective : (granted === '*' ? null : granted);
    const grantedCount = known ? effective?.length : (granted === '*' ? totalActions : granted.length);

    const sends = sendsFor(known ? effective : granted, app);
    const storedConfirm = storedConfirmOf(toolsConfig, appId);
    // Locked as soon as the app CAN send, also at `'*'`. The stored value may be `direct` there (normalisation forces only
    // on a LIST), but `confirmForTool` decides at dispatch based on the effect and then still says `ask`. A switch that
    // shows "direct" where the runtime always asks is a stored promise that nobody keeps.
    const confirmLocked = sends !== false;
    const confirm = confirmLocked ? CONFIRM.ASK : (storedConfirm || CONFIRM.DIRECT);

    const provider = app && typeof app.provider === 'string' && app.provider ? app.provider : null;
    let actAsKind: string = ACT_AS_KIND.UNKNOWN;
    if (app && app.providersKnown) actAsKind = provider ? ACT_AS_KIND.USER : ACT_AS_KIND.PLATFORM;

    const lentKnown = lentApps instanceof Set;
    const canActAsOwner = actAsKind === ACT_AS_KIND.USER
        && !!lendingEnabled
        && lentKnown
        && lentApps.has(appId)
        // A borrowed connection never sends without the owner present: the same refusal as in normaliseToolsConfig, and there
        // unknown also counts as sending.
        && sends === false;

    const storedActAs = storedActAsOf(toolsConfig, appId);
    const actAs = canActAsOwner && storedActAs === ACT_AS.OWNER ? ACT_AS.OWNER : ACT_AS.VIEWER;

    const { ownerLendsUncurated, ownerLendingUnset } = lendingNoticeOf({
        actAsKind, appId, lentApps, lendingEnabled, curated, storedActAs,
    });

    return {
        appId,
        label: label || (app && app.label) || appId,
        granted,
        grantedNames,
        grantedCount,
        totalActions,
        actionsKnown: known,
        available: app ? (app.available === undefined ? null : app.available) : null,
        // WHY it may be missing (catalogue: `availabilityKind`). "This installation does not have it" is a different fact from
        // "you have not connected it", and the card may only say the sentence that is true. Unknown stays null: then the
        // general sentence stands there, not an invented one.
        availabilityKind: app && typeof app.availabilityKind === 'string' && app.availabilityKind
            ? app.availabilityKind
            : null,
        // ALL causes why this app may be missing. `availabilityKind` is only filled if there is EXACTLY ONE. With more, it
        // would assert a fact that does not come from the measurement ("this installation does not have it" while it is
        // about the account). See routes/agents/toolCatalog.js.
        availabilityKinds: app && Array.isArray(app.availabilityKinds)
            ? app.availabilityKinds.filter(k => typeof k === 'string' && k)
            : [],
        sends,
        // Which OTHER app narrows this row (the same tools, a stricter grant). Empty if nothing intersects.
        narrowedBy,
        confirm,
        confirmLocked,
        actAsKind,
        actAs,
        canActAsOwner,
        // "The owner chose owner, but that is no longer allowed": the row says so out loud, instead of silently showing
        // `viewer` as if that were the choice.
        ownerRefused: storedActAs === ACT_AS.OWNER && !canActAsOwner,
        ownerLendsUncurated,
        ownerLendingUnset,
    };
}
