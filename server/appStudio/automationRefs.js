// @typecheck
/**
 * "Which button of this app runs which automation": pure.
 *
 * This is the READ side of the new index `automation_usage` (P4 part C). It answers exactly one
 * question about one app definition: which automations does it name, from which button, on which
 * screen. The write side is in `appStudio/automationUsageSync.js`, the table in
 * `stores/automationUsageStore.js`.
 *
 * ── WHY THIS IS NOT A FIELD IN `automation_datatable_usage` ──────────
 *
 * That index is keyed per TABLE TARGET, and that is a FK, not a convention:
 * `datatable_id TEXT NOT NULL REFERENCES datatables(id) ON DELETE CASCADE`
 * (stores/datatableStore.js). An app→automation row has no datatable, so there is no value that
 * may go in there. `reconcileUsageFor` writes via `INSERT … SELECT … FROM datatables d WHERE
 * d.id = $6`, so without a table row it writes ZERO rows and reports itself successful. That is
 * exactly the silent gate this whole family must prevent. Hence a table of its own.
 *
 * ── THE KEY IS THE ACTION, NOT THE STEP ─────────────────────────────
 *
 * A sequence step has NO id: `containsStepKind` (validate/actions.js) walks it by position. A
 * position as half a primary key is exactly what W5 forbids: with every edit it shifts, the
 * reconcile writes a new row, and the index grows until it means nothing. The ACTION does have a
 * stable id (`act_xxxx`, enforced by validate.js' checkId), so the row is one per
 * (app, action, automation). Two `run_automation` steps in the same sequence that run the same
 * automation are one row; if they run different automations, there are two, because the
 * automation_id is part of the key.
 *
 * ── AN UNWIRED ACTION STILL COUNTS ──────────────────────────────────
 *
 * An action that hangs on an automation but on no button at all (`action.unreachable` in the
 * validator) yields a row WITH an empty button address. The temptation is to skip it, since
 * nobody can press it, but the index is what makes a deletion loud, and the same direction applies
 * as with W5: one row too many makes a deletion louder, one row too few makes it silent.
 * `wired:false` marks the difference, so that the screen can show "not yet wired to a button"
 * instead of an invented button name.
 *
 * ── ONE VOCABULARY, TWO WALKS ──────────────────────────────────────
 *
 * `collectReferencedActions` (validate/nodes.js) knows which actions are reachable, but it returns
 * only the ids, not the button. This module walks the same tree ONCE MORE to find the BUTTON, with
 * the same event names (`EVENT_NAMES`, imported) and the same four action-list props (mirrored,
 * because those are not exported there; same consideration as `NAMING_PROPS` in appRefLookup.js).
 * That the two walks do not drift apart is not a promise but a test: automationUsageSync.test.js
 * compares the key set with `collectReferencedActions` over a fixture that contains every wiring form.
 */

'use strict';

const { EVENT_NAMES } = require('./componentSpecs');
const { nodeOwnText } = require('./appRefLookup');

/**
 * The props in which a component names an action by ID instead of via an event. Mirrored from
 * validate/nodes.js#collectReferencedActions; see the header for why that is a mirror and not an import.
 */
const ACTION_LIST_PROPS = Object.freeze(['itemActions', 'rowActions', 'bulkActions', 'toolbarActions']);

/** Het voorvoegsel van `ref_id`. Zie de kop: de ACTIE is de sleutel. */
const REF_PREFIX = 'act:';

function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The automations that one action runs, in order of first occurrence.
 *
 * Both the v1 form (`kind:'run_automation'` on the action itself) and the sequence step. The
 * recursion is exactly that of `containsStepKind` (validate/actions.js): `steps`, `then`, `else`,
 * `cases[].steps` and `default`, the FIVE places where a step can contain a step. That "exactly" is
 * not a promise but a test: automationUsageSync.test.js compares the two recursions field by field.
 *
 * @returns {{ids: string[], unset: number}} `unset` counts the
 *   `run_automation` places WITHOUT an automation (`automationId: null`, the state in which every
 *   template is shipped). Those are NOT usage, but they do belong in the log line.
 */
function automationsInAction(action) {
    const ids = [];
    let unset = 0;
    const seen = new Set();

    const take = (obj) => {
        const aid = obj && typeof obj.automationId === 'string' ? obj.automationId.trim() : '';
        if (!aid) { unset += 1; return; }
        if (seen.has(aid)) return;
        seen.add(aid);
        ids.push(aid);
    };

    const walkSteps = (steps, depth) => {
        // The same depth limit as the validator (MAX_ACTION_STEP_DEPTH is an error there,
        // here only a stop): a hand-written definition must not be able to drive this scan into a cycle.
        if (!Array.isArray(steps) || depth > 12) return;
        for (const step of steps) {
            if (!isObject(step)) continue;
            if (step.kind === 'run_automation') take(step);
            walkSteps(step.steps, depth + 1);
            walkSteps(step.then, depth + 1);
            walkSteps(step.else, depth + 1);
            for (const c of (Array.isArray(step.cases) ? step.cases : [])) {
                if (isObject(c)) walkSteps(c.steps, depth + 1);
            }
            // `default` — the FIFTH entry, and the one that was missing here. Both
            // the browser (runtime/useActionRunner: `execSteps(hit ? hit.steps
            // : step.default)`) and the server (appStudio/actionSequence.js)
            // really run that branch, so an automation that existed only there
            // ran fine and was not in the index — and then the capsule says
            // "No app button runs this automation yet" on screen, and someone
            // decides to delete it.
            walkSteps(step.default, depth + 1);
        }
    };

    if (!isObject(action)) return { ids, unset };
    if (action.kind === 'run_automation') take(action);
    walkSteps(action.steps, 1);
    return { ids, unset };
}

/**
 * Which BUTTON switches on each action: action id → { screenId, nodeId, label }.
 *
 * The FIRST location in document order wins. Two buttons on the same action is
 * one place in the app that runs the automation — the row names the first one,
 * and that is more honest than a second row that pretends they are two
 * different links.
 */
function collectActionSites(screens) {
    const sites = new Map();
    const remember = (actionId, screenId, node) => {
        if (typeof actionId !== 'string' || !actionId) return;
        if (sites.has(actionId)) return;
        sites.set(actionId, {
            screenId: screenId || null,
            nodeId: typeof node?.id === 'string' ? node.id : null,
            label: nodeOwnText(node),
        });
    };

    const visit = (node, screenId) => {
        if (!isObject(node)) return;
        for (const ev of EVENT_NAMES) {
            if (typeof node[ev] === 'string' && node[ev]) remember(node[ev], screenId, node);
        }
        const props = isObject(node.props) ? node.props : {};
        for (const key of ACTION_LIST_PROPS) {
            for (const entry of (Array.isArray(props[key]) ? props[key] : [])) {
                if (isObject(entry) && typeof entry.actionId === 'string') remember(entry.actionId, screenId, node);
            }
        }
        if (typeof props.addRowActionId === 'string') remember(props.addRowActionId, screenId, node);
        for (const col of (Array.isArray(props.columns) ? props.columns : [])) {
            if (isObject(col) && typeof col.actionId === 'string') remember(col.actionId, screenId, node);
        }
        for (const child of (Array.isArray(node.children) ? node.children : [])) visit(child, screenId);
    };

    for (const screen of (Array.isArray(screens) ? screens : [])) {
        if (!isObject(screen)) continue;
        const screenId = typeof screen.id === 'string' ? screen.id : null;
        for (const section of (Array.isArray(screen.sections) ? screen.sections : [])) {
            if (!isObject(section)) continue;
            for (const child of (Array.isArray(section.children) ? section.children : [])) visit(child, screenId);
        }
    }
    return sites;
}

/**
 * Every (action, automation) pair that this definition names.
 *
 * Pure and defensive: a malformed action is skipped, never thrown. A definition
 * that is not an object yields an EMPTY list — and the caller may NOT read that as
 * "this app uses nothing" without first knowing that the definition was really read.
 * See line 1 in automationUsageSync.js.
 *
 * @returns {{entries: Array<{automationId:string, refId:string, actionId:string,
 *            screenId:string|null, nodeId:string|null, label:string|null,
 *            wired:boolean}>, unset:number}}
 */
function collectAutomationRefs(definition) {
    const def = isObject(definition) ? definition : {};
    const actions = isObject(def.actions) ? def.actions : {};
    const sites = collectActionSites(def.screens);

    const entries = [];
    let unset = 0;
    for (const [actionId, action] of Object.entries(actions)) {
        if (typeof actionId !== 'string' || !actionId) continue;
        const found = automationsInAction(action);
        unset += found.unset;
        const site = sites.get(actionId) || null;
        for (const automationId of found.ids) {
            entries.push({
                automationId,
                refId: `${REF_PREFIX}${actionId}`,
                actionId,
                screenId: site ? site.screenId : null,
                nodeId: site ? site.nodeId : null,
                label: site ? site.label : null,
                // See the heading: an unwired action counts, but says so too.
                wired: !!site,
            });
        }
    }
    return { entries, unset };
}

module.exports = {
    collectAutomationRefs,
    collectActionSites,
    automationsInAction,
    ACTION_LIST_PROPS,
    REF_PREFIX,
};
