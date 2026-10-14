/**
 * App Studio — the references an action or a screen carries, and how removing
 * one strips every place that names it. Split out of definitionOps.ts for its
 * size budget; definitionOps re-exports what the editor imports.
 */

import { mapAllNodes } from '@shared/appDefinition/definitionOps.mjs';
import type { AppAction, AppDefinition, AppNode } from '../inspector/appDefinition';

/** A step (or a case body holder) of an action sequence, as plain data. */
type Step = Record<string, unknown>;

// The full event vocabulary a node may carry (mirror of EVENT_NAMES in
// server/appStudio/componentSpecs.js). setNodeEvent accepts any of these; which
// events a given component TYPE actually supports is governed by the inspector
// (styleKnobMeta.TYPE_EVENT_LISTS) and validated server-side.
//
// `onDecided` hoorde hier al thuis en ontbrak. Serverzijdig bestaat het
// (componentSpecs/screenSpec.js), approval_list staat het toe
// (recordListSpecs.js), de inspector RENDERT het slot (styleKnobMeta.
// TYPE_EVENT_LISTS + ActionsSection.EVENT_LABELS) en de runtime VOERT het uit
// (runtime/components/AppApprovalList.jsx). Alleen deze lijst wist er niets
// van, met vier stille gevolgen: setNodeEvent viel op de guard hieronder terug
// en gaf de def ONGEWIJZIGD terug (een mens kon het slot dus niet bedraden —
// klik, geen effect, geen fout), nodeLogicSummary/countLogicMarks telden de
// bedrading niet mee, ActionsSection's eventRefsToAction liet bij het
// verwijderen van een actie een onDecided-verwijzing hangen, en eventText zette
// de rauwe identifier in een zin. Een event dat stil verdwijnt is precies wat
// de Logica-tab moet uitsluiten, dus de lijst is nu compleet.
export const NODE_EVENTS: string[] = ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange', 'onDecided'];

/** Drop every action reference to a dialog that is no longer there. */
export function stripModalRefs(def: AppDefinition, modalId: string): AppDefinition {
    let next = def;
    // A whole action whose only job was this dialog goes, with its wiring.
    for (const [actionId, action] of Object.entries(next.actions || {})) {
        if (action && (action.kind === 'open_modal' || action.kind === 'close_modal')
            && action.modalId === modalId) {
            next = removeAction(next, actionId);
        }
    }
    let dirty = false;
    const actions: Record<string, AppAction> = {};
    for (const [id, action] of Object.entries(next.actions || {})) {
        let copy: AppAction = action;
        if (action && typeof action === 'object') {
            const steps = stripModalSteps(copy.steps, modalId);
            if (steps !== copy.steps) copy = { ...copy, steps };
        }
        if (copy !== action) dirty = true;
        actions[id] = copy;
    }
    return dirty ? { ...next, actions } : next;
}

/** The same recursive walk stripNavigateSteps does, for modal steps. */
function stripModalSteps(steps: unknown[] | undefined, modalId: string): unknown[] | undefined {
    if (!Array.isArray(steps)) return steps;
    let dirty = false;
    const next: unknown[] = [];
    for (const item of steps) {
        if (!item || typeof item !== 'object') { next.push(item); continue; }
        const step = item as Step;
        if ((step.kind === 'open_modal' || step.kind === 'close_modal') && step.modalId === modalId) {
            dirty = true;
            continue;
        }
        let copy: Step = step;
        for (const key of ['then', 'else', 'steps', 'default']) {
            const branch = stripModalSteps(step[key] as unknown[] | undefined, modalId);
            if (branch !== step[key]) copy = { ...copy, [key]: branch };
        }
        if (Array.isArray(step.cases)) {
            let casesDirty = false;
            const cases = (step.cases as unknown[]).map((c) => {
                if (!c || typeof c !== 'object') return c;
                const caseBody = c as { steps?: unknown[] };
                const branch = stripModalSteps(caseBody.steps, modalId);
                if (branch === caseBody.steps) return c;
                casesDirty = true;
                return { ...caseBody, steps: branch };
            });
            if (casesDirty) copy = { ...copy, cases };
        }
        if (copy !== step) dirty = true;
        next.push(copy);
    }
    return dirty ? next : steps;
}

/**
 * Drop the navigate steps that target `screenId` from a sequence's step list,
 * recursing branch bodies (condition then/else, loop steps, switch cases and
 * default) — same shapes canonicalize.js walks server-side.
 */
function stripNavigateSteps(steps: unknown[] | undefined, screenId: string): unknown[] | undefined {
    if (!Array.isArray(steps)) return steps;
    let dirty = false;
    const next: unknown[] = [];
    for (const item of steps) {
        if (!item || typeof item !== 'object') { next.push(item); continue; }
        const step = item as Step;
        if (step.kind === 'navigate' && step.screenId === screenId) { dirty = true; continue; }
        let copy: Step = step;
        for (const key of ['then', 'else', 'steps', 'default']) {
            const branch = stripNavigateSteps(step[key] as unknown[] | undefined, screenId);
            if (branch !== step[key]) copy = { ...copy, [key]: branch };
        }
        if (Array.isArray(step.cases)) {
            let casesDirty = false;
            const cases = (step.cases as unknown[]).map((c) => {
                if (!c || typeof c !== 'object') return c;
                const caseBody = c as { steps?: unknown[] };
                const branch = stripNavigateSteps(caseBody.steps, screenId);
                if (branch === caseBody.steps) return c;
                casesDirty = true;
                return { ...caseBody, steps: branch };
            });
            if (casesDirty) copy = { ...copy, cases };
        }
        if (copy !== step) dirty = true;
        next.push(copy);
    }
    return dirty ? next : steps;
}

/** Strip effects' navigateTo + sequence navigate steps aimed at `screenId`. */
export function stripScreenRefs(actions: Record<string, AppAction> | undefined, screenId: string): Record<string, AppAction> | undefined {
    let dirty = false;
    const next: Record<string, AppAction> = {};
    for (const [id, action] of Object.entries(actions || {})) {
        let copy: AppAction = action;
        if (action && typeof action === 'object') {
            for (const slot of ['onSuccess', 'onError']) {
                const effects = copy[slot] as { navigateTo?: unknown } | undefined;
                if (effects && typeof effects === 'object' && effects.navigateTo === screenId) {
                    const { navigateTo: _gone, ...rest } = effects;
                    copy = { ...copy, [slot]: rest };
                }
            }
            const steps = stripNavigateSteps(copy.steps, screenId);
            if (steps !== copy.steps) copy = { ...copy, steps };
        }
        if (copy !== action) dirty = true;
        next[id] = copy;
    }
    return dirty ? next : actions;
}

// ---------------------------------------------------------------------------
// Action ops
// ---------------------------------------------------------------------------

/**
 * Remove an action and strip EVERY reference to it that a node can carry.
 *
 * Dat waren er lang maar twee: `onClick` en `onSubmit`. De overige vijf events
 * (onRowClick, onRowSelect, onCardMove, onChange, onDecided) en de zes
 * actie-oppervlakken (rowActions, itemActions, bulkActions, toolbarActions,
 * props.addRowActionId, props.columns[].actionId) bleven hangen — en een
 * hangende verwijzing is serverzijdig een HARDE fout (`event.action_unresolved`,
 * validate/nodes.js), dus 422 op PUT /:id/definition, useAppAutosave dat zijn
 * basislijn niet verzet, en elke volgende toetsaanslag die dezelfde afgewezen
 * save opnieuw afvuurt. Precies de vastloper die de doc van `removeNode`
 * hierboven zegt te hebben opgelost: een dialoog verwijderen jamde de hele
 * editor met een fout over een component dat niet meer bestond.
 *
 * De lijst events komt uit NODE_EVENTS — één lijst, zodat een event dat daar
 * bijkomt hier niet vergeten kan worden. De oppervlakken staan hieronder
 * uitgeschreven in dezelfde volgorde als collectReferencedActions op de server.
 */
const NODE_ACTION_LISTS = ['rowActions', 'itemActions', 'bulkActions', 'toolbarActions'];

/**
 * De zes actie-oppervlakken van één node, zonder deze actie — of `null` als er
 * niets naar wees.
 *
 * Een LIJST-entry gaat er HELEMAAL uit: een rijknop zonder actie is een knop die
 * niets doet, en die stilletjes laten staan is dezelfde stilte als een hangende
 * verwijzing. Een KOLOM blijft wel bestaan (hij toont een waarde) en raakt
 * alleen zijn actie kwijt.
 */
function propsWithoutAction(props: Record<string, unknown> | null | undefined, actionId: string): Record<string, unknown> | null {
    if (!props || typeof props !== 'object') return null;
    let dirty = false;
    const next: Record<string, unknown> = { ...props };
    for (const key of NODE_ACTION_LISTS) {
        const list = Array.isArray(props[key]) ? (props[key] as unknown[]) : null;
        if (!list || !list.some((e) => e && (e as { actionId?: unknown }).actionId === actionId)) continue;
        next[key] = list.filter((e) => !e || (e as { actionId?: unknown }).actionId !== actionId);
        dirty = true;
    }
    if (props.addRowActionId === actionId) { delete next.addRowActionId; dirty = true; }
    const columns = Array.isArray(props.columns) ? (props.columns as unknown[]) : null;
    if (columns && columns.some((c) => c && (c as { actionId?: unknown }).actionId === actionId)) {
        next.columns = columns.map((col) => {
            if (!col || (col as { actionId?: unknown }).actionId !== actionId) return col;
            const { actionId: _gone, ...rest } = col as Record<string, unknown>;
            return rest;
        });
        dirty = true;
    }
    return dirty ? next : null;
}

export function removeAction(def: AppDefinition, actionId: string): AppDefinition {
    if (!def.actions || !(actionId in def.actions)) return def;
    const actions = { ...def.actions };
    delete actions[actionId];
    return mapAllNodes({ ...def, actions }, (node: AppNode) => {
        const events = NODE_EVENTS.filter((ev) => node[ev] === actionId);
        const props = propsWithoutAction(node.props, actionId);
        if (!events.length && !props) return node;
        const copy: AppNode = { ...node };
        for (const ev of events) delete copy[ev];
        if (props) copy.props = props as AppNode['props'];
        return copy;
    });
}

