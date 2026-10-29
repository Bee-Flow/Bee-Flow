import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutGraph } from '../layout';
import { newStep, type ActionStep } from '../stepCatalog';
import { canConnect, graphToSteps, makeId, parseId, stepsToGraph, stripStepIds, withStepIds, type FlowStep, type GraphNode, type StepNode } from '../stepGraph';
import useStepReferences from '../useStepReferences';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { NodeRuntimeContext } from '@/components/automation/Builder/flow/NodeRuntimeContext';
import toast from '@/components/shared/Toast';
import type { BandItem } from '@/components/automation/Builder/flow/rowBands';
import type { Connection } from '@xyflow/system';
import type { FlowBodyProps } from '../ActionFlowEditor.types';
import { indexAfter, dropScopeEdges, canMove, normalizeToSequence, summarise, duplicateInGraph, withNewStep } from './ActionFlowEditor.helpers';
import { StepFlowNode } from './StepFlowNode';
import { FlowBodySection } from './FlowBodySection';
import { PickOrAddStep, SelectedStepPanel, StepContextMenu, StepPalette } from './FlowStepPanels';

const NODE_TYPES_KEY = 'appStudioStep';

interface FlowNodesArgs {
    nodes: GraphNode[];
    positions: ReturnType<typeof layoutGraph>;
    selectedId: string | null;
    options: Parameters<typeof summarise>[1];
    t: TranslateFn;
    disabled: boolean;
    setSelectedId: (id: string | null) => void;
    setAdding: (adding: { prefix: string; after?: string } | null) => void;
    setCtxMenu: (menu: BandItem | null) => void;
}

/** The React Flow nodes: derived positions (never draggable), each with its summary and its select / add / menu handlers. */
function flowNodesFor({ nodes, positions, selectedId, options, t, disabled, setSelectedId, setAdding, setCtxMenu }: FlowNodesArgs) {
    return nodes.map((n) => ({
        id: n.id,
        type: NODE_TYPES_KEY,
        position: positions.get(n.id) || { x: 0, y: 0 },
        draggable: false,       // position is derived; dragging would lie
        selectable: !n.isEntry,
        data: {
            node: n,
            selected: n.id === selectedId,
            summary: summarise(n.step, options, t),
            onSelect: () => setSelectedId(n.isEntry ? null : n.id),
            onAdd: () => setAdding({ prefix: n.prefix }),
            // The "+" on the node itself — add a step straight after this one,
            // the same gesture the automation builder offers.
            onAddAfter: n.isEntry ? null : () => setAdding({ prefix: n.prefix, after: n.id }),
            onContextMenu: n.isEntry ? undefined : (e: React.MouseEvent) => {
                e.preventDefault();
                setSelectedId(n.id);
                setCtxMenu({ id: n.id, x: e.clientX, y: e.clientY });
            },
            disabled,
        },
    }));
}

export function FlowBody({ action, onChange, definition, node = null, disabled = false, formFields = [] }: FlowBodyProps) {
    const { t } = useTranslation();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [adding, setAdding] = useState<{ prefix: string; after?: string } | null>(null);   // { prefix, after? } — where
    const [ctxMenu, setCtxMenu] = useState<BandItem | null>(null); // { id, x, y } — right-click

    // Ids are editor-only: assigned on the way in, stripped on the way out.
    const withIds = useMemo(() => withStepIds(normalizeToSequence(action)), [action]);
    const graph = useMemo(() => stepsToGraph(withIds, t), [withIds, t]);
    const positions = useMemo(() => layoutGraph(graph.nodes), [graph.nodes]);

    const screens = useMemo(() => definition?.screens || [], [definition?.screens]);
    const references = useStepReferences(definition);
    const selected = graph.nodes.find((n): n is StepNode => n.id === selectedId && !n.isEntry) || null;

    /**
     * The scope a step was just appended to, held until the new graph arrives.
     *
     * A step's id is DERIVED from its position on every render (withStepIds
     * numbers the tree in pre-order) and stripped again on the way out, so the
     * temporary id addStep hands to graphToSteps does not survive the round
     * trip. Selecting that id therefore selected nothing: you picked "Show a
     * message" from the palette and the settings panel stayed on "Pick a step
     * to change it", with the new step's required Message field never shown.
     *
     * So the position is what is held, and resolved to an id once the rebuilt
     * graph is in hand.
     */
    const pendingScopeRef = useRef<{ prefix: string; at: number; } | null>(null);
    const tempIdRef = useRef(0);
    useEffect(() => {
        const pending = pendingScopeRef.current;
        if (!pending) return;
        pendingScopeRef.current = null;
        const scoped = graph.nodes.filter((n) => n.prefix === pending.prefix && !n.isEntry);
        const added = scoped[pending.at] || scoped[scoped.length - 1];
        if (added) setSelectedId(added.id);
    }, [graph]);

    const commitSteps = useCallback((steps: FlowStep[]) => {
        onChange({ kind: 'sequence', steps: stripStepIds(steps) });
    }, [onChange]);

    /** Replace one step, wherever it sits. */
    const patchStep = useCallback((id: string, patch: ActionStep) => {
        const nodes = graph.nodes.map((n) => (n.id === id ? { ...n, step: { ...n.step, ...patch } } as GraphNode : n));
        commitSteps(graphToSteps(nodes, graph.edges));
    }, [graph, commitSteps]);

    const removeStep = useCallback((id: string) => {
        const gone = new Set([id, ...graph.nodes.filter((n) => n.id.startsWith(`${id}/`)).map((n) => n.id)]);
        const nodes = graph.nodes.filter((n) => !gone.has(n.id));
        const edges = graph.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
        setSelectedId(null);
        commitSteps(graphToSteps(nodes, edges));
    }, [graph, commitSteps]);

    /**
     * Put a new step in one scope — at `at` (0-based) or, by default, at the
     * end. The automations canvas offers "+" on the node itself for exactly
     * this, so a step can be added where it belongs rather than only at the
     * bottom and then walked up.
     */
    const addStep = useCallback((kind: string, prefix: string, at: number | null = null) => {
        // Editor-only and thrown away by the commit below; a counter rather than
        // a clock so two adds in the same millisecond cannot share an id.
        tempIdRef.current += 1;
        const step = { ...newStep(kind, { screenId: screens[0]?.id || '', t }), id: `n${tempIdRef.current}` };
        const added = withNewStep(graph, kind, step, prefix, at);
        setAdding(null);
        pendingScopeRef.current = { prefix, at: added.at };
        commitSteps(graphToSteps(added.nodes, added.edges));
    }, [graph, screens, commitSteps, t]);

    /**
     * A copy of one step, right after the original — and everything inside it.
     *
     * graphToSteps rebuilds a container's children from the GRAPH, not from the
     * step object, so copying the step alone would produce a duplicate with
     * every branch emptied. The whole subtree is re-prefixed under the copy's
     * id and its edges come along, which is what keeps the branches populated
     * and in order.
     */
    const duplicateStep = useCallback((id: string) => {
        const { prefix } = parseId(id);
        const at = graph.nodes.filter((n) => n.prefix === prefix && !n.isEntry).findIndex((n) => n.id === id);
        if (at === -1) return;

        tempIdRef.current += 1;
        const copy = duplicateInGraph(graph, id, makeId(prefix, `n${tempIdRef.current}`));
        pendingScopeRef.current = { prefix, at: at + 1 };
        commitSteps(graphToSteps(copy.nodes, copy.edges));
    }, [graph, commitSteps]);

    /**
     * Move a step one place within its own branch.
     *
     * Reordering was only ever offered as a drag between the node handles, and
     * that could never succeed: the graph is re-derived from the tree on every
     * render as a COMPLETE chain, so every node already has its one incoming
     * and one outgoing edge and canConnect refused every pair — inside a branch
     * on the fan-in rule, at the root on the cycle rule. There is also no
     * edge-delete path (the canvas passes no onEdgesChange/deleteKeyCode), so
     * there was nothing to disconnect first. Deleting a step and rebuilding it
     * further down was the only way to reorder anything.
     *
     * The automations canvas reorders by dropping a step onto a connection,
     * which its DAG model allows. An app action is a strict tree, so order
     * lives in the ARRAY: this reorders one scope's nodes and drops that
     * scope's edges, and graphToSteps reads the scope back in node order
     * (orderScope falls through to `previousOrder` when nothing constrains it).
     */
    const moveStep = useCallback((id: string, delta: number) => {
        const { prefix } = parseId(id);
        const scoped = graph.nodes.filter((n) => n.prefix === prefix && !n.isEntry);
        const at = scoped.findIndex((n) => n.id === id);
        const to = at + delta;
        if (at === -1 || to < 0 || to >= scoped.length) return;

        const reordered = scoped.slice();
        [reordered[at], reordered[to]] = [reordered[to], reordered[at]];

        // Rebuild the node list with this scope's nodes in their new order,
        // leaving every other scope exactly where it was.
        let next = 0;
        const nodes = graph.nodes.map((n) => (
            (n.prefix === prefix && !n.isEntry) ? reordered[next++] : n
        ));
        pendingScopeRef.current = { prefix, at: to };
        commitSteps(graphToSteps(nodes, dropScopeEdges(graph.edges, prefix)));
    }, [graph, commitSteps]);

    const onConnect = useCallback((connection: Connection) => {
        const verdict = canConnect(connection.source, connection.target, graph.edges, graph.nodes, t);
        if (!verdict.ok) { toast.info(verdict.reason); return; }
        commitSteps(graphToSteps(graph.nodes, [
            ...graph.edges,
            { id: `${connection.source}->${connection.target}`, from: connection.source, to: connection.target },
        ]));
    }, [graph, commitSteps, t]);

    const rfNodes = useMemo(
        () => flowNodesFor({ nodes: graph.nodes, positions, selectedId, options: references.options, t, disabled, setSelectedId, setAdding, setCtxMenu }),
        [graph.nodes, positions, selectedId, disabled, references.options, t],
    );

    /**
     * The step actions StepNodeBase draws on hover. It reads them from this
     * context in the automation builder too, so providing it here is all it takes
     * for an app step to behave like an automation step.
     */
    const nodeRuntime = useMemo(() => ({
        onDeleteNode: disabled ? null : removeStep,
        onDuplicateNode: disabled ? null : duplicateStep,
        // No partial execution, pinning, detaching or inline layers here — the
        // context's own defaults cover every one of those.
        attachedIds: new Set<string>(),
    }), [disabled, removeStep, duplicateStep]);

    const rfEdges = useMemo(() => graph.edges.map((e) => ({
        id: e.id, source: e.from, target: e.to, type: 'smoothstep',
    })), [graph.edges]);

    const nodeTypes = useMemo(() => ({ [NODE_TYPES_KEY]: StepFlowNode }), []);
    const rootEmpty = graph.nodes.filter((n) => n.prefix === '').length === 0;

    return (
        <NodeRuntimeContext.Provider value={nodeRuntime}>
        <div className="flex h-full min-h-[420px] w-full gap-3" data-action-flow>
            <FlowBodySection rfNodes={rfNodes} rfEdges={rfEdges} nodeTypes={nodeTypes} disabled={disabled} onConnect={onConnect} setSelectedId={setSelectedId} setAdding={setAdding} rootEmpty={rootEmpty} t={t} />

            <aside className="w-[300px] shrink-0 overflow-y-auto rounded-md border border-[var(--border-subtle)] p-3">
                {adding ? (
                    <StepPalette
                        onPick={(kind) => addStep(kind, adding.prefix, indexAfter(graph, adding.after))}
                        onCancel={() => setAdding(null)}
                    />
                ) : selected ? (
                    <SelectedStepPanel
                        t={t} selected={selected} disabled={disabled} canMoveEarlier={canMove(graph, selected.id, -1)} canMoveLater={canMove(graph, selected.id, 1)}
                        onMove={(delta) => moveStep(selected.id, delta)} onRemove={() => removeStep(selected.id)} onPatch={(next) => patchStep(selected.id, next)}
                        definition={definition} node={node} screens={screens} formFields={formFields}
                    />
                ) : (
                    <PickOrAddStep t={t} disabled={disabled} onAdd={() => setAdding({ prefix: '' })} />
                )}
            </aside>

            {/* The automation builder's own right-click menu, unchanged. */}
            {ctxMenu ? <StepContextMenu menu={ctxMenu} disabled={disabled} onDuplicate={duplicateStep} onDelete={removeStep} onClose={() => setCtxMenu(null)} /> : null}
        </div>
        </NodeRuntimeContext.Provider>
    );
}
