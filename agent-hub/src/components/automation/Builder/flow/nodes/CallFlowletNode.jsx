import { Handle, Position } from '@xyflow/react';
import { Layers, SquareArrowOutUpRight, ChevronDown, Users } from 'lucide-react';
import React from 'react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase from './StepNodeBase';
import { CONTAINER_HEADER } from '../inlineFlowlets';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { statusVar, typeColorVar, typeTint } from '../nodeTypeColors';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * A "call_layer" node — runs an inline flowlet (sub-flow declared in
 * definition.layers) as a single step.
 *
 * Two shapes:
 *   collapsed — the ordinary 240×72 card: flowlet label, what it does, the
 *               mapped inputs, an "Open flowlet" drill-in in the badge slot,
 *               and the icon tile as the way to expand it in place (the card
 *               has no room for a separate chevron).
 *   expanded  — a container whose contents (the flowlet's own steps, rendered
 *               by DiagramPane as React Flow child nodes) sit inside it, so
 *               the sub-flow is visible and editable in the flow that uses it.
 *               Only the header strip is drawn here; the body is the space the
 *               children occupy.
 */
export default function CallFlowletNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter, inlineExpanded: container } = data;
    const { onOpenLayer, layerSummaries, onToggleInline, layerRefCounts } = useNodeRuntime();
    const summary = step.layerKey ? (layerSummaries?.[step.layerKey] || '') : '';
    const canToggle = !!onToggleInline && !!step.layerKey;
    const toggle = (e) => { e?.stopPropagation?.(); onToggleInline(id, step.layerKey); };

    if (container) {
        return <ExpandedFlowlet id={id} step={step} summary={summary} runStep={runStep}
            refCount={layerRefCounts?.[step.layerKey] || 0}
            onOpenLayer={onOpenLayer} onToggle={canToggle ? toggle : null} />;
    }

    const inputs = step.inputs && typeof step.inputs === 'object' ? Object.keys(step.inputs) : [];
    const inputsText = inputs.length === 0
        ? 'no inputs mapped'
        : `${inputs.length} input${inputs.length === 1 ? '' : 's'}: ${inputs.slice(0, 4).join(', ')}${inputs.length > 4 ? '…' : ''}`;
    const sub = summary ? `${summary} · ${inputsText}` : (inputs.length === 0 ? { muted: inputsText } : inputsText);

    const badges = (onOpenLayer && step.layerKey) ? (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenLayer(step.layerKey); }}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label={t('automations.call_flowlet_node.open_flowlet', 'Open flowlet')}
            title={t('automations.call_flowlet_node.open_this_flowlet_on_its_own', 'Open this flowlet on its own canvas')}
            className="h-5 w-5 rounded-md flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
        >
            <SquareArrowOutUpRight size={11} />
        </button>
    ) : null;

    return (
        <StepNodeBase
            icon={<Layers size={14} />}
            typeLabel={nodeTypeLabel('call_layer')}
            help={nodeHelp('call_layer')}
            name={step.label || step.layerKey || 'Flowlet'}
            sub={sub}
            subTitle={summary || undefined}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
            onTileClick={canToggle ? toggle : null}
            tileLabel="Expand — show this flowlet's steps here"
        />
    );
}

/**
 * The container. Sized by DiagramPane (node.style), so this fills 100% and
 * only draws chrome: a header strip and the two connection handles, which stay
 * on the header rather than the box's vertical middle — on a tall container the
 * middle is nowhere near where the eye expects the flow to enter and leave.
 *
 * The dashed border and tinted body say "this is not one step, it's a piece of
 * flow borrowed from somewhere else". A run status paints the border solid in
 * the status colour — the same rule as a card.
 */
function ExpandedFlowlet({ id, step, summary, runStep, refCount, onOpenLayer, onToggle }) {
    const { t } = useTranslation();
    // Same rule as a card, and now from the same place: nodeTypeColors reads
    // the shared status table, so a running flowlet is the blue the run panel
    // draws it in rather than the amber this file used to pick, and a
    // flowlet waiting on an approval finally has a colour at all.
    const statusColor = statusVar(runStep?.status);
    const border = statusColor ? `2px solid ${statusColor}` : `1.5px dashed ${typeColorVar('loop')}`;
    const portClass = '!w-3 !h-3 !bg-[var(--bg-primary)] !border-2 !border-[var(--text-tertiary)]';
    return (
        <div className="w-full h-full rounded-2xl relative" style={{ border, background: typeTint('loop', 4) }}>
            <Handle type="target" position={Position.Left} id="in"
                style={{ top: CONTAINER_HEADER / 2 }} className={portClass} />
            <div
                className="flex items-center gap-2 px-3"
                style={{ height: CONTAINER_HEADER, borderBottom: `1px dashed ${typeColorVar('loop')}` }}
            >
                <span
                    className="text-[10px] font-semibold uppercase tracking-[.08em] shrink-0"
                    style={{ color: typeColorVar('loop') }}
                >
                    <Layers size={12} className="inline-block align-[-2px] mr-1" />
                    {t('automations.call_flowlet_node.flowlet', 'Flowlet')}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold truncate">{step.label || step.layerKey || 'Flowlet'}</div>
                    {summary && <div className="text-[10px] text-[var(--text-tertiary)] italic truncate">{summary}</div>}
                </div>
                {refCount > 1 && (
                    <span
                        title={`This flowlet is used in ${refCount} places — changes here apply to all of them.`}
                        className="shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: 'color-mix(in srgb, var(--warning) 16%, transparent)', color: 'var(--warning)' }}
                    >
                        <Users size={10} /> {refCount}
                    </span>
                )}
                {onOpenLayer && step.layerKey && (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenLayer(step.layerKey); }}
                        title={t('automations.call_flowlet_node.open_this_flowlet_on_its_own', 'Open this flowlet on its own canvas')}
                        className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        <SquareArrowOutUpRight size={13} />
                    </button>
                )}
                {onToggle && (
                    <button
                        type="button"
                        onClick={onToggle}
                        title={t('automations.call_flowlet_node.collapse_this_flowlet', 'Collapse this flowlet')}
                        className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        <ChevronDown size={15} />
                    </button>
                )}
            </div>
            <Handle type="source" position={Position.Right} id="out"
                style={{ top: CONTAINER_HEADER / 2 }} className={portClass} />
            {/* `id` is unused visually but keeps the container addressable in
                tests and by the canvas's focusStep helper. */}
            <span className="hidden" data-node-id={id} />
        </div>
    );
}
