import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutGraph } from '../layout';
import { newStep, paletteGroups, stepMeta, type ActionStep } from '../stepCatalog';
import { canConnect, graphToSteps, makeId, parseId, SEP, stepsToGraph, stripStepIds, withStepIds, type FlowStep, type GraphNode, type StepNode } from '../stepGraph';
import StepSettings from '../StepSettings';
import useStepReferences from '../useStepReferences';
import useTranslation from '../../../../../../hooks/useTranslation';
import NodeContextMenu from '../../../../../automation/Builder/flow/NodeContextMenu';
import { NodeRuntimeContext } from '../../../../../automation/Builder/flow/NodeRuntimeContext';
import IconButton from '../../../../../shared/IconButton';
import toast from '../../../../../shared/Toast';
import type { BandItem } from '../../../../../automation/Builder/flow/rowBands';
import type { Connection } from '@xyflow/system';
import type { FlowBodyProps, StepPaletteProps } from '../ActionFlowEditor.types';
import { indexAfter, spliceScope, dropScopeEdges, canMove, normalizeToSequence, summarise } from './ActionFlowEditor.helpers';
import { StepFlowNode } from './StepFlowNode';
import { FlowBodySection } from './FlowBodySection';

const NODE_TYPES_KEY = 'appStudioStep';

export function FlowBody({ action, onChange, definition, node = null, disabled = false, formFields = [] }: FlowBodyProps) {
    const { t } = useTranslation();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [adding, setAdding] = useState<{ prefix: string; after?: string } | null>(null);   // { prefix, after? } — where
    const [ctxMenu, setCtxMenu] = useState<BandItem | null>(null); // { id, x, y } — right-click

    // Ids are editor-only: assigned on the way in, stripped on the way out.
    const withIds = useMemo(() => withStepIds(normalizeToSequence(action)), [action]);
    const graph = useMemo(() => stepsToGraph(withIds, t), [withIds, t]);
    const positions = useMemo(() => layoutGraph(graph.nodes), [graph.nodes]);

    const screens = definition?.screens || [];
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
        const id = prefix ? `${prefix}/${step.id}` : step.id;
        const scopeNodes = graph.nodes.filter((n): n is StepNode => n.prefix === prefix && !n.isEntry);
        const last = scopeNodes[scopeNodes.length - 1];
        const entry = graph.nodes.find((n) => n.isEntry && n.prefix === prefix);

        const fresh: StepNode = {
            id, kind, step, prefix,
            parentId: entry?.parentId ?? null,
            scopeKey: entry?.scopeKey ?? null,
            scopeLabel: entry?.scopeLabel ?? null,
            isEntry: false,
        };

        setAdding(null);
        if (at == null) {
            // Appending: keep the chain and hang the new step off the last one.
            const from = last?.id || entry?.id;
            const edges = from ? [...graph.edges, { id: `${from}->${id}`, from, to: id }] : graph.edges;
            pendingScopeRef.current = { prefix, at: scopeNodes.length };
            commitSteps(graphToSteps([...graph.nodes, fresh], edges));
            return;
        }
        // Inserting: splice into the scope's node order and drop that scope's
        // edges, which encode the OLD order (see moveStep).
        pendingScopeRef.current = { prefix, at };
        commitSteps(graphToSteps(spliceScope(graph.nodes, prefix, at, fresh), dropScopeEdges(graph.edges, prefix)));
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
        const scoped = graph.nodes.filter((n): n is StepNode => n.prefix === prefix && !n.isEntry);
        const at = scoped.findIndex((n) => n.id === id);
        if (at === -1) return;

        tempIdRef.current += 1;
        const copyId = makeId(prefix, `n${tempIdRef.current}`);
        const remap = (nid: string) => copyId + nid.slice(id.length);
        const inside = (nid: string) => nid.startsWith(`${id}${SEP}`);

        // stripStepIds clears the editor-only ids from the copy's whole subtree,
        // so the duplicate cannot collide with the original's children.
        const [copiedStep] = stripStepIds([scoped[at].step]);
        const copy = { ...scoped[at], id: copyId, step: copiedStep };

        const descendants = graph.nodes.filter((n) => inside(n.id)).map((n) => ({
            ...n,
            id: remap(n.id),
            prefix: remap(n.prefix),
            parentId: n.parentId && inside(n.parentId) ? remap(n.parentId) : copyId,
        }));
        const descendantEdges = graph.edges
            .filter((e) => inside(e.from) && inside(e.to))
            .map((e) => ({ id: `${remap(e.from)}->${remap(e.to)}`, from: remap(e.from), to: remap(e.to) }));

        pendingScopeRef.current = { prefix, at: at + 1 };
        commitSteps(graphToSteps(
            [...spliceScope(graph.nodes, prefix, at + 1, copy), ...descendants],
            [...dropScopeEdges(graph.edges, prefix), ...descendantEdges],
        ));
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

    const rfNodes = useMemo(() => graph.nodes.map((n) => ({
        id: n.id,
        type: NODE_TYPES_KEY,
        position: positions.get(n.id) || { x: 0, y: 0 },
        draggable: false,       // position is derived; dragging would lie
        selectable: !n.isEntry,
        data: {
            node: n,
            selected: n.id === selectedId,
            summary: summarise(n.step, references.options, t),
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
    })), [graph.nodes, positions, selectedId, disabled, references.options, t]);

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
                    <div className="flex flex-col gap-3">
                        <header className="flex items-center gap-2">
                            <h3 className="flex-1 text-sm font-semibold text-[var(--text-primary)]">
                                {stepMeta(selected.kind, t).label}
                            </h3>
                            <IconButton
                                ariaLabel={t('studio_apps_edit.action_flow.move_earlier', 'Move this step earlier')}
                                size="sm"
                                disabled={disabled || !canMove(graph, selected.id, -1)}
                                onClick={() => moveStep(selected.id, -1)}
                            >
                                <ChevronUp />
                            </IconButton>
                            <IconButton
                                ariaLabel={t('studio_apps_edit.action_flow.move_later', 'Move this step later')}
                                size="sm"
                                disabled={disabled || !canMove(graph, selected.id, 1)}
                                onClick={() => moveStep(selected.id, 1)}
                            >
                                <ChevronDown />
                            </IconButton>
                            <IconButton
                                ariaLabel={t('studio_apps_edit.action_flow.delete_step', 'Delete this {kind} step', { kind: stepMeta(selected.kind, t).label.toLowerCase() })}
                                variant="danger"
                                size="sm"
                                disabled={disabled}
                                onClick={() => removeStep(selected.id)}
                            >
                                <Trash2 />
                            </IconButton>
                        </header>
                        <StepSettings
                            step={selected.step}
                            onChange={(next) => patchStep(selected.id, next)}
                            definition={definition}
                            node={node}
                            screens={screens}
                            formFields={formFields}
                            disabled={disabled}
                        />
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs text-[var(--text-secondary)]">
                            {t('studio_apps_edit.action_flow.pick_or_add', 'Pick a step to change it, or add one to the end.')}
                        </p>
                        <button
                            type="button"
                            onClick={() => setAdding({ prefix: '' })}
                            disabled={disabled}
                            className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        >
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('studio_apps_edit.action_flow.add_step', 'Add a step')}
                        </button>
                    </div>
                )}
            </aside>

            {/* The automation builder's own right-click menu, unchanged. */}
            {ctxMenu ? (
                <NodeContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    canDelete={!disabled}
                    canDuplicate={!disabled}
                    onDuplicate={() => duplicateStep(ctxMenu.id)}
                    onDelete={() => removeStep(ctxMenu.id)}
                    onClose={() => setCtxMenu(null)}
                />
            ) : null}
        </div>
        </NodeRuntimeContext.Provider>
    );
}

function StepPalette({ onPick, onCancel }: StepPaletteProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3">
            <header className="flex items-center gap-2">
                <h3 className="flex-1 text-sm font-semibold text-[var(--text-primary)]">{t('studio_apps_edit.action_flow.add_step', 'Add a step')}</h3>
                <button
                    type="button"
                    onClick={onCancel}
                    className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] rounded px-1"
                >
                    {t('studio_apps_edit.action_flow.cancel', 'Cancel')}
                </button>
            </header>
            {paletteGroups(t).map(({ group, label: groupName, kinds }) => (
                <div key={group} className="flex flex-col gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{groupName}</span>
                    {kinds.map(({ kind, label, blurb, icon: Icon }) => (
                        <button
                            key={kind}
                            type="button"
                            onClick={() => onPick(kind)}
                            className="flex items-start gap-2 text-left rounded-md border border-[var(--border-subtle)] px-2 py-1.5 hover:bg-[var(--bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        >
                            <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                            <span className="min-w-0">
                                <span className="block text-xs font-medium text-[var(--text-primary)]">{label}</span>
                                <span className="block text-[11px] text-[var(--text-secondary)]">{blurb}</span>
                            </span>
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}
