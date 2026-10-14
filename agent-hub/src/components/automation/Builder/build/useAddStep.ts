import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import {
    addAndPlace, addNode, autoMapToastMessage, defaultAddPosition, findNode, lastStepId, LOOP_BODY_REFUSALS, wiringFor,
} from './addStepModel';
import type { AddStepOptions, AddStepPayload, Position, Wiring } from './addStepModel';
import { toast } from '../../../shared/Toast';
import { createLayerInDefinition, getScopedGraph, setScopedGraph } from '../flow/flowletScope';
import { flowToScopePosition as flowToScopePositionJs, parseInlineId, prefixAddedStep } from '../flow/inlineFlowlets';
import { normalizeDefinitionShape, emptyGraph } from '../flow/normalizeDefinition';
import { followAfterAdd } from '../flow/routeFollowNotes';
import { defaultTriggerLabel } from '../flow/triggerLabels';
import type { FlowDefinition, FlowStep } from '../flow/types';
import { applyAutoMapToStep as applyAutoMapToStepJs } from '../mapping/autoMapInputs';
import type { TranslateFn } from '../../../../hooks/useTranslation';

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

// inlineFlowlets.js is JavaScript whose `= null` default reads as the parameter's whole type.
const flowToScopePosition = flowToScopePositionJs as (
    prefix: string, absPos: Position, graph: FlowDefinition | null, sidecar: Map<string, SidecarEntry>, shiftById?: unknown,
) => Position;

interface AutoMapResult { definition: FlowDefinition; mappedKeys: string[]; forEachEnabled?: boolean }
// autoMapInputs.js is JavaScript whose `= {}` default reads as the parameter's whole type.
const applyAutoMapToStep = applyAutoMapToStepJs as (
    definition: FlowDefinition, stepId: string, catalog: unknown, opts: { realOutputById?: unknown },
) => AutoMapResult;

interface ConfirmOptions { title: string; description: string; confirmLabel: string; destructive: boolean }

/** The canvas surface the insert path asks for its centre. */
interface DiagramHandle { getCenter?: () => Position | null }

/** What one expanded flowlet on the canvas is (flow/inlineFlowlets.js). */
interface SidecarEntry { kind?: string; [key: string]: unknown }

export interface UseAddStepOptions {
    flatDef: FlowDefinition | null;
    inlineSidecar: Map<string, SidecarEntry>;
    inlineShift: unknown;
    rootDef: FlowDefinition | null;
    scopeKey: string | null;
    setScopeKey?: ((key: string | null) => void) | null;
    onVisualEditFlat?: ((def: FlowDefinition) => void) | null;
    onVisualEditRoot?: ((def: FlowDefinition) => void) | null;
    autoMapEnabled: boolean;
    catalog: unknown;
    realOutputById: unknown;
    recordUsage: (payload: AddStepPayload, sourceStep?: FlowStep | null) => void;
    confirmAction: (opts: ConfirmOptions) => Promise<boolean>;
    t: TranslateFn;
    diagramRef: RefObject<DiagramHandle | null>;
}

/**
 * Picking a trigger that can only be the ONE primary trigger replaces the one
 * there. That is a destructive answer to a search, so it asks first (BFSF-325).
 */
function replacesPrimaryTrigger(payload: AddStepPayload, baseDef: FlowDefinition): boolean {
    return payload.kind === 'trigger' && !payload.asSecondaryTrigger && !payload.__confirmedReplace && !!baseDef.trigger
        && (baseDef.trigger.kind || 'manual') !== payload.triggerKind;
}

/** The confirm shown before a primary trigger is replaced. */
function replaceTriggerQuestion(baseDef: FlowDefinition, payload: AddStepPayload): ConfirmOptions {
    const from = defaultTriggerLabel(baseDef.trigger?.kind || 'manual');
    const to = defaultTriggerLabel(payload.triggerKind || 'manual');
    return {
        title: `Replace the ${from} trigger with ${to}?`,
        description: 'An automation can only have one trigger of these kinds, so the current one and its settings are replaced.',
        confirmLabel: 'Replace',
        destructive: true,
    };
}

/**
 * "Create flowlet" — a scope-spanning insert: register the new flowlet on the
 * WHOLE document, drop a call_layer step referencing it into the CURRENT
 * canvas (wired from edgeSource when set), commit both in ONE history entry,
 * then drill straight into the flowlet.
 */
function addCreateLayerCall({ rootDef, scopeKey, baseDef, payload, position, wiring }: {
    rootDef: FlowDefinition | null; scopeKey: string | null; baseDef: FlowDefinition; payload: AddStepPayload;
    position: Position; wiring: Wiring;
}): { root: FlowDefinition; layerKey: string } {
    const { definition: withLayer, layerKey } = createLayerInDefinition(rootDef, payload.title || 'New flowlet') as
        { definition: FlowDefinition; layerKey: string };
    const currentGraph = (getScopedGraph(withLayer, scopeKey) as FlowDefinition | null) || baseDef;
    const layerTitle = withLayer.layers?.[layerKey]?.title || 'New flowlet';
    const nextGraph = addNode(
        currentGraph,
        { kind: 'call_layer', layerKey, label: layerTitle },
        // The call node joins the CANVAS's graph, not whichever flowlet the
        // pointer happened to be over.
        position,
        wiring.scopePrefix ? null : wiring.sourceId,
        wiring.scopePrefix ? null : wiring.sourceHandle,
    );
    return { root: setScopedGraph(withLayer, scopeKey, nextGraph) as FlowDefinition, layerKey };
}

/**
 * The one insert path of BuildTab. Every add-a-step surface funnels through
 * here with an explicit target description, so positioning, edge-splicing,
 * auto-map, usage telemetry and the create-flowlet meta-action behave
 * identically whether the step came from the ribbon (click OR drag), the
 * search box, the node "+", the edge "+", or an edge dropped on empty canvas.
 * Split out of BuildTab without a change in behaviour.
 */
export default function useAddStep(o: UseAddStepOptions) {
    const {
        flatDef, inlineSidecar, inlineShift, rootDef, scopeKey, setScopeKey, onVisualEditFlat, onVisualEditRoot,
        autoMapEnabled, catalog, realOutputById, recordUsage, confirmAction, t, diagramRef,
    } = o;
    const tr: Translate = t;
    // Step ids added while the catalog was still loading, auto-mapped once it lands.
    const pendingAutoMapRef = useRef<string[]>([]);

    /**
     * Auto-map the new step's inputs from its upstream source and follow the
     * route (a step wired next to a list Condition reads what it KEEPS). Only
     * when wired from a source node — a bare add has no upstream to map from.
     */
    const mapAndFollow = useCallback((next: FlowDefinition, sourceId: string | null, addedId: string | null, scopePrefix: string) => {
        let finalDef = next;
        const insertedId = lastStepId(next);
        if (autoMapEnabled && sourceId && insertedId) {
            if (catalog) {
                const { definition: mappedDef, mappedKeys, forEachEnabled } = applyAutoMapToStep(next, insertedId, catalog, { realOutputById });
                finalDef = mappedDef;
                if (mappedKeys.length || forEachEnabled) {
                    toast.success(autoMapToastMessage(mappedKeys.length, !!forEachEnabled));
                }
            } else if (!scopePrefix) {
                // Catalog still loading (a step added within ~1s of page load):
                // queue the id and let the drain effect below map it once the
                // catalog lands — safe to run late because auto-map never
                // overwrites non-empty bindings. Only for the canvas's own
                // graph: the drain works off the scoped definition and knows
                // nothing about prefixes.
                pendingAutoMapRef.current.push(insertedId);
            }
        }
        // Same commit as the add, so one Undo (shared/expr/routeFollow.mjs).
        if (sourceId && addedId) {
            const followed = followAfterAdd(finalDef, addedId, tr);
            finalDef = followed.definition as FlowDefinition;
            for (const msg of followed.messages) toast.success(msg);
        }
        return finalDef;
    }, [autoMapEnabled, catalog, realOutputById, tr]);

    /**
     * Where the step lands: refused inside a loop it cannot live in (null),
     * converted into a flowlet's own origin, or — with no drop point — next to
     * its source, the rightmost card or the canvas centre.
     */
    const resolvePosition = useCallback((payload: AddStepPayload, opts: AddStepOptions, baseDef: FlowDefinition, w: Wiring) => {
        // Not everything can live inside a loop: say so at the gesture rather
        // than from a red banner two edits later.
        if (w.scopePrefix && inlineSidecar.get(w.scopePrefix)?.kind === 'loop') {
            const refusal = LOOP_BODY_REFUSALS[payload.kind];
            if (refusal) { toast.info(refusal); return null; }
        }
        let position = opts.position || null;
        // Inside a flowlet the graph has its own origin.
        if (w.scopePrefix && position) {
            position = flowToScopePosition(w.scopePrefix, position, flatDef, inlineSidecar, inlineShift);
        }
        // Record usage for the smart Add-step recommender before the add proceeds.
        recordUsage(payload, w.sourceId ? findNode(baseDef, w.sourceId) : null);
        return position || defaultAddPosition(baseDef, w.sourceId, payload.kind, () => diagramRef.current?.getCenter?.());
    }, [flatDef, inlineSidecar, inlineShift, recordUsage, diagramRef]);

    const addStepAt = useCallback((payload: AddStepPayload | null, opts: AddStepOptions = {}) => {
        if (!payload) return;
        // Fresh automations have no draft yet: seed a minimal skeleton. Shape-
        // normalise, don't just null-check: a poisoned `{}` definition is truthy
        // and applyAddNode's trigger branch would then emit a graph with no
        // steps/edges (BFSF-318).
        const baseDef = (normalizeDefinitionShape(flatDef) as FlowDefinition | null) || (emptyGraph() as FlowDefinition);

        // The in-app dialog is a promise and this function is synchronous, so
        // a confirmed replace re-enters with the answer.
        if (replacesPrimaryTrigger(payload, baseDef)) {
            confirmAction(replaceTriggerQuestion(baseDef, payload))
                .then((ok) => { if (ok) addStepAt({ ...payload, __confirmedReplace: true }, opts); });
            return;
        }

        const w = wiringFor(payload, opts, id => parseInlineId(id).prefix);
        const position = resolvePosition(payload, opts, baseDef, w);
        if (!position) return;

        if (payload.kind === 'create_layer') {
            // The call node joins the CANVAS's graph, in canvas coordinates.
            const { root, layerKey } = addCreateLayerCall({
                rootDef, scopeKey, baseDef, payload, position: opts.position || position, wiring: w,
            });
            onVisualEditRoot?.(root);
            setScopeKey?.(layerKey);
            return;
        }

        const { next, addedId } = addAndPlace(baseDef, payload, position, w, opts);
        let finalDef = mapAndFollow(next, w.sourceId, addedId, w.scopePrefix);
        // Last: move the new step into the flowlet it was added to. Everything
        // above addressed it by its bare id; the bindings auto-map just wrote
        // are flat ids that decompose turns back into local ones.
        const insertedId = lastStepId(next);
        if (w.scopePrefix && finalDef.steps?.length && insertedId) {
            finalDef = prefixAddedStep(finalDef, insertedId, w.scopePrefix) as FlowDefinition;
        }
        onVisualEditFlat?.(finalDef);
    // addStepAt calls itself after the replace-trigger confirm resolves; listing
    // it would be circular, and the identity it closes over is the same one on
    // both passes.
    }, [flatDef, rootDef, scopeKey, setScopeKey, onVisualEditFlat, onVisualEditRoot, confirmAction, resolvePosition, mapAndFollow]);

    usePendingAutoMapDrain({ pendingAutoMapRef, flatDef, realOutputById, catalog, onVisualEditFlat, t: tr });

    return addStepAt;
}

/**
 * Auto-maps the steps queued while the catalog was loading, once it lands.
 * Reads the latest definition and real-output map through refs: by the time
 * the catalog arrives, the add-time closure is stale.
 */
function usePendingAutoMapDrain({ pendingAutoMapRef, flatDef, realOutputById, catalog, onVisualEditFlat, t }: {
    pendingAutoMapRef: { current: string[] };
    flatDef: FlowDefinition | null;
    realOutputById: unknown;
    catalog: unknown;
    onVisualEditFlat?: ((def: FlowDefinition) => void) | null;
    t: Translate;
}) {
    const scopedDefRef = useRef(flatDef);
    const realOutputRef = useRef(realOutputById);
    useEffect(() => { scopedDefRef.current = flatDef; realOutputRef.current = realOutputById; });
    useEffect(() => {
        if (!catalog || !pendingAutoMapRef.current.length) return;
        const ids = pendingAutoMapRef.current.splice(0);
        let def = scopedDefRef.current;
        if (!def) return;
        let mappedAny = false, keysTotal = 0, anyForEach = false;
        const messages: string[] = [];
        for (const id of ids) {
            const r = applyAutoMapToStep(def, id, catalog, { realOutputById: realOutputRef.current });
            if (r.mappedKeys.length || r.forEachEnabled) {
                def = r.definition;
                mappedAny = true;
                keysTotal += r.mappedKeys.length;
                anyForEach = anyForEach || !!r.forEachEnabled;
            }
            // The Condition only became a list Condition just now: follow it here too.
            const followed = followAfterAdd(def, id, t);
            def = followed.definition as FlowDefinition;
            messages.push(...followed.messages);
        }
        if (mappedAny || messages.length) onVisualEditFlat?.(def);
        if (mappedAny) toast.success(autoMapToastMessage(keysTotal, anyForEach));
        for (const msg of messages) toast.success(msg);
    }, [catalog, onVisualEditFlat, t, pendingAutoMapRef]);
}
