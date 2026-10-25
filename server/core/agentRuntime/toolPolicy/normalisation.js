// @typecheck
/**
 * CLAMPING a stored `config.tools` — on write and on read both, and never by
 * throwing.
 *
 * Every branch here answers the same question the same way: an unreadable
 * value is the NARROW reading, said out loud in `warnings`, and an entry is
 * KEPT granting nothing rather than dropped — because a missing app entry
 * means "every action of this app", so dropping one WIDENS the grant it was
 * meant to refuse.
 */

'use strict';

const { effectOf } = require('../../automationModel/sideEffectMap');
const {
    _plainObject, toolsConfigOf, RESERVED_TOOL_KEYS, CONFIRM_MODES, ACT_AS_MODES,
    DATATABLE_SCOPES, UNSAFE_OBJECT_KEYS,
    MAX_APP_ENTRIES, MAX_ACTIONS_PER_APP, MAX_AUTOMATION_GRANTS, MAX_DATATABLE_GRANTS,
} = require('./configShape');
const { actionsOfApp, appDefersGrants, isAttributionAvailable } = require('./appIndex');
const { _datatableColumns } = require('./reservedGrants');
const { _providerForApp } = require('./connectionLending');

// ── Normalisation ───────────────────────────────────────────────────

/**
 * Clamp a config's `tools` map. Pure except for the optional lend-grant probe,
 * never throws, and returns a NEW object — the caller decides whether to write
 * it back (`PUT` does, `getForRuntime` uses it for this turn only).
 *
 * @param {object} config                 the agent config (not mutated)
 * @param {object} [opts]
 * @param {string} [opts.agentId]         the lend grant's resource id
 * @param {string} [opts.ownerId]         the agent owner (the grantor)
 * @param {Set<string>|null} [opts.lentProviders]  providers with a live lend
 *   grant for this agent. Pass null/undefined and every `actAs:'owner'` is
 *   downgraded — fail closed, because "I could not check" is not "yes".
 * @returns {{tools: object|null, warnings: string[], changed: boolean}}
 */
function normaliseToolsConfig(config, opts = {}) {
    const raw = toolsConfigOf(config);
    if (!raw) return { tools: null, warnings: [], changed: false };

    const lent = opts.lentProviders instanceof Set ? opts.lentProviders : null;
    const out = {};
    // `note` records a warning and marks the config changed; `touch` marks it
    // changed without a warning (an entry rewritten into its canonical shape).
    const st = { warnings: [], changed: false };
    st.note = (msg) => { st.warnings.push(msg); st.changed = true; };
    st.touch = () => { st.changed = true; };

    const appKeys = Object.keys(raw).filter(k => !RESERVED_TOOL_KEYS.includes(k));
    // Over the bound the surplus apps are KEPT, granting nothing — they are
    // not dropped. A dropped entry is not a smaller grant, it is a bigger one:
    // a MISSING entry means "every action of this app" (see the header), so
    // truncating the list handed apps 201+ their whole toolbelt, and
    // `applyConfigValidation` wrote that widening into the row. Exactly the
    // failure the bare-string branch in normaliseActions already had, by
    // another door. The bound is about the WORK a config costs on every turn,
    // and an empty entry costs none of it: no registry lookup, no effect scan,
    // no set.
    let overflowKeys = [];
    if (appKeys.length > MAX_APP_ENTRIES) {
        overflowKeys = appKeys.slice(MAX_APP_ENTRIES);
        st.note(`tools: more than ${MAX_APP_ENTRIES} apps (${appKeys.length}) — the apps past that grant ` +
            'no actions until they are picked again');
        appKeys.length = MAX_APP_ENTRIES;
    }

    for (const appId of appKeys) out[appId] = normaliseAppEntry(appId, raw[appId], lent, st);

    // The surplus, spelled out. `{actions: []}` is the narrow reading of "this
    // app is past the bound" — never no entry at all, which reads as the whole
    // app to every reader here.
    for (const appId of overflowKeys) out[appId] = { actions: [], actAs: 'viewer' };

    if (raw.automations !== undefined) {
        const autos = normaliseAutomations(raw.automations, st);
        if (autos) out.automations = autos;
    }
    if (raw.datatables !== undefined) {
        const tables = normaliseDatatables(raw.datatables, st);
        if (tables) out.datatables = tables;
    }

    return { tools: out, warnings: st.warnings, changed: st.changed };
}

/** One app entry, clamped: actions, confirm and actAs. */
function normaliseAppEntry(appId, entry, lent, st) {
    if (!_plainObject(entry)) {
        // KEPT, granting nothing — never dropped. Dropping is the widening
        // this whole function exists to refuse: a MISSING entry means
        // "every action of this app" (see the header), so deleting
        // `{gmail: "nope"}` handed the agent the whole of Gmail, and
        // `applyConfigValidation` wrote that widening into the row on the
        // next PUT. Exactly the same door the bare-string branch in
        // normaliseActions and the overflow branch already had closed; this
        // one was still open, and it is the only branch here that made a
        // grant BIGGER than the one that was sent.
        st.note(`tools.${appId}: entry is not an object — kept, but no actions granted`);
        st.touch();
        return { actions: [], actAs: 'viewer' };
    }

    const known = actionsOfApp(appId);
    const { actions, actionsMissing } = normaliseActions(appId, entry.actions, known, st);

    // ── confirm ──
    let confirm = CONFIRM_MODES.includes(entry.confirm) ? entry.confirm : undefined;
    // A picked list that contains a SEND can never be `direct`. This is the
    // stored half of the rule; `confirmForTool` enforces the same thing at
    // dispatch, so a config that skipped this path is still safe.
    const listedSends = Array.isArray(actions) && actions.some(a => effectOf(a) === 'sends');
    if (listedSends && confirm !== 'ask') {
        if (confirm === 'direct') st.note(`tools.${appId}: confirm "direct" is not available for actions that send — forced to "ask"`);
        confirm = 'ask';
    }

    const actAs = normaliseActAs(appId, entry.actAs, { actions, known, lent }, st);

    const normalised = actionsMissing ? { actAs } : { actions, actAs };
    if (confirm) normalised.confirm = confirm;
    if (!_sameEntry(entry, normalised)) st.touch();
    return normalised;
}

/**
 * An app entry's `actions`. A MISSING actions key stays missing (A2
 * objection): turning it into `'*'` here wrote a choice into the row that
 * nobody made — the card stores `{confirm}` or `{actAs}` without `actions`,
 * and for a `grantsRequireEntry` app "the owner named this app" is something
 * very different from "the owner gave it everything". `_appAllowsTool` reads
 * the absence narrowly where that applies, so nothing needs filling in here,
 * and not filling in is the only reading that never widens.
 */
function normaliseActions(appId, value, known, st) {
    if (value === '*') return { actions: '*', actionsMissing: false };
    if (value === undefined || value === null) return { actions: '*', actionsMissing: true };
    if (Array.isArray(value)) {
        const knownSet = new Set(known);
        const seen = new Set();
        const actions = [];
        for (const a of value) {
            if (typeof a !== 'string' || !a || seen.has(a)) continue;
            // An unknown action name is dropped ONLY when we actually know
            // this app's catalogue. For an app the registry does not carry
            // (an MCP server, a custom integration) we cannot tell a typo
            // from a tool that loads at runtime, and deleting the user's
            // choice on a guess is worse than keeping an inert one.
            if (known.length > 0 && !knownSet.has(a)) { st.note(`tools.${appId}: unknown action "${a}" dropped`); continue; }
            seen.add(a);
            actions.push(a);
            if (actions.length >= MAX_ACTIONS_PER_APP) break;
        }
        return { actions, actionsMissing: false };
    }
    // NEVER "*". A value nobody can read is not a request for
    // everything: `{ actions: 'gmail_search' }` — one legacy client
    // sending a bare string — used to come back as the whole of Gmail,
    // and `applyConfigValidation` then wrote that widening into the
    // row on the next PUT. Unreadable ⇒ no action granted, said out
    // loud, so the owner re-picks instead of silently getting more
    // than they asked for.
    st.note(`tools.${appId}: actions must be an array or "*" — no actions granted, pick them again`);
    return { actions: [], actionsMissing: false };
}

/** An app entry's `actAs`: `owner` survives only without sends and with a live lend grant. */
function normaliseActAs(appId, value, { actions, known, lent }, st) {
    let actAs = ACT_AS_MODES.includes(value) ? value : 'viewer';
    if (actAs === 'owner' && appDefersGrants(appId)) {
        // This app supplies the tools of ANOTHER app on the same credentials
        // (`grantsVia`). The identity question is answered where the names
        // belong; storing it here yields a field that steers nothing — the
        // card would read "as the owner" while the gate reads the owner's
        // entry. Refuse and say so, rather than keep it and stay silent.
        st.note(`tools.${appId}: "as the owner" is decided on the app that owns these tools — ` +
            'reset to "as the person asking"');
        actAs = 'viewer';
    }
    if (actAs !== 'owner') return actAs;
    // `'*'` means "every action of this app", and whether any of them
    // sends comes from the registry — so with attribution degraded the
    // answer is unknown, and unknown counts as "it sends". Otherwise a
    // registry blip is all it takes for a borrowed connection to keep
    // `owner` on an app whose send actions would have refused it.
    const sendsHere = Array.isArray(actions)
        ? actions.some(a => effectOf(a) === 'sends')
        : (!isAttributionAvailable() || known.some(a => effectOf(a) === 'sends'));
    if (sendsHere) {
        // A borrowed connection never sends without its owner present.
        // Refusing the IDENTITY rather than the whole save keeps a
        // fat-fingered picker from bouncing an otherwise valid agent.
        st.note(`tools.${appId}: "as the owner" is refused for actions that send — reset to "as the person asking"`);
        return 'viewer';
    }
    if (!lent || !lent.has(_providerForApp(appId))) {
        st.note(`tools.${appId}: no lent connection for this app — reset to "as the person asking"`);
        return 'viewer';
    }
    return actAs;
}

/** The `automations` section, or undefined when it is dropped. */
function normaliseAutomations(rawAutos, st) {
    if (!_plainObject(rawAutos)) {
        st.note('tools.automations: not an object — dropped');
        return undefined;
    }
    const ids = Object.keys(rawAutos).slice(0, MAX_AUTOMATION_GRANTS);
    if (ids.length < Object.keys(rawAutos).length) st.note(`tools.automations: kept the first ${MAX_AUTOMATION_GRANTS}`);
    const autos = {};
    for (const id of ids) {
        const g = rawAutos[id];
        let confirm = _plainObject(g) && CONFIRM_MODES.includes(g.confirm) ? g.confirm : undefined;
        // A confirm nobody can read is NOT "no confirm". An empty grant
        // means `direct` — the automation fires the moment the model asks
        // for it — so letting `'Ask'`, `true` or a grant that is not an
        // object at all fall through to `{}` turns a typo into "sends
        // without asking", silently. Same rule as the `actions` branch:
        // unreadable is the NARROW reading, said out loud.
        //
        // The grant itself survives: the ID is the half that IS
        // readable, and dropping it would take an automation its owner
        // deliberately picked out of the agent without saying so.
        // Only the unreadable half — the confirm — is decided against
        // the caller, exactly like `actAs: 'owner'`.
        if (!_plainObject(g)) {
            st.note(`tools.automations.${id}: grant is not an object — kept, but set to "ask"`);
            confirm = 'ask';
        } else if (g.confirm !== undefined && !confirm) {
            st.note(`tools.automations.${id}: confirm must be "direct" or "ask" — set to "ask"`);
            confirm = 'ask';
        }
        autos[id] = confirm ? { confirm } : {};
        if (!_sameEntry(g, autos[id])) st.touch();
    }
    // An EMPTY section survives on purpose. "I unticked every automation" is
    // a choice, and throwing it away here makes it indistinguishable from
    // "the owner never chose" — after which the reader offers the asker's
    // full list. Unticking would then yield everything; exactly backwards.
    return autos;
}

/**
 * The `datatables` section, or undefined when it is dropped.
 *
 * Stored since A1c, because `core/tools/datatableTools.js` now enforces
 * both halves: the tool is offered only for a granted table, and every
 * call re-reads `scope`/`columns` off the published config before it
 * compiles a query. Before that it was DROPPED here with a warning for two
 * releases — a limit nothing applies is worse than no feature, because the
 * owner reads "own rows, these columns" back and believes it. That refusal
 * is what this branch replaces, not something it forgot.
 *
 * (`datatables` stays a RESERVED key regardless: without that it would read
 * as an app entry, and an app entry with no `actions` means EVERY action.)
 */
function normaliseDatatables(rawTables, st) {
    if (!_plainObject(rawTables)) {
        st.note('tools.datatables: not an object — dropped');
        return undefined;
    }
    const allIds = Object.keys(rawTables);
    const ids = allIds.slice(0, MAX_DATATABLE_GRANTS);
    // TRUNCATED, not spelled out as an empty entry the way the app
    // overflow is: a missing app entry means "every action of this
    // app", so dropping one WIDENS. A missing datatable entry means
    // the table is not granted at all, so dropping one narrows — this
    // section has no "absent means everything" reading to protect.
    if (ids.length < allIds.length) st.note(`tools.datatables: kept the first ${MAX_DATATABLE_GRANTS}`);
    const tables = {};
    for (const id of ids) {
        if (UNSAFE_OBJECT_KEYS.has(id)) {
            st.note(`tools.datatables.${id}: not a datatable id — dropped`);
            continue;
        }
        const g = rawTables[id];
        if (!_plainObject(g)) {
            // The ID is the readable half and the owner deliberately
            // picked it, so the grant survives — narrowed to its own
            // rows and to no columns, which `datatable_query` refuses
            // out loud. Same shape as the automations section.
            st.note(`tools.datatables.${id}: grant is not an object — kept, but narrowed to nothing readable`);
            tables[id] = { scope: 'own', columns: [] };
            continue;
        }
        if (g.scope !== undefined && !DATATABLE_SCOPES.includes(g.scope)) {
            st.note(`tools.datatables.${id}: scope must be "own" or "all" — set to "own"`);
        }
        if (g.columns !== undefined && g.columns !== '*' && !Array.isArray(g.columns)) {
            st.note(`tools.datatables.${id}: columns must be a list or "*" — no columns granted, pick them again`);
        }
        const scope = DATATABLE_SCOPES.includes(g.scope) ? g.scope : 'own';
        const columns = _datatableColumns(g.columns);
        if (Array.isArray(columns) && Array.isArray(g.columns) && columns.length < g.columns.length) {
            st.note(`tools.datatables.${id}: dropped columns that were empty or repeated`);
        }
        tables[id] = { scope, columns };
        if (!_sameEntry(g, tables[id])) st.touch();
    }
    // An empty section survives, exactly like `automations`: "I removed
    // every table" is a choice, and dropping it here would make it
    // indistinguishable from "the owner never picked one".
    return tables;
}

function _sameEntry(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}

module.exports = { normaliseToolsConfig };

/**
 * The running state of one normalisation: the warnings so far and whether
 * anything changed. `note`/`touch` are attached right after creation.
 * @typedef {{ warnings: string[], changed: boolean, note?: (msg: string) => void, touch?: () => void }} NormState
 */
