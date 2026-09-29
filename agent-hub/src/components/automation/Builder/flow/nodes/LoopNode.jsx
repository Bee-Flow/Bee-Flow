import { Handle, Position } from '@xyflow/react';
import { ChevronDown, Repeat } from 'lucide-react';
import React from 'react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import { humanizeExpression } from '../displayHelpers';
import { CONTAINER_HEADER } from '../inlineFlowlets';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { statusVar, typeColorVar, typeTint } from '../nodeTypeColors';
import { useTranslation } from '../../../../../hooks/useTranslation';

export default function LoopNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById, inlineExpanded: container } = data;
    const { onToggleInline } = useNodeRuntime();
    const friendlyOver = humanizeExpression(step.overRef || '', stepLabelById);
    // A loop's body is inline data, not a reference — so unlike a flowlet there
    // is no cycle to guard against and nothing to look up. It can always open.
    // The second argument is the flowlet key the toggle would collapse a rival
    // expansion of; a body is never shared, so there is none.
    const toggle = onToggleInline ? (e) => { e?.stopPropagation?.(); onToggleInline(id, null); } : null;

    if (container) {
        return <ExpandedLoop id={id} step={step} runStep={runStep} friendlyOver={friendlyOver} onToggle={toggle} />;
    }
    return (
        <CollapsedLoop
            id={id} step={step} runStep={runStep} issues={issues}
            onAddAfter={onAddAfter} friendlyOver={friendlyOver} onToggle={toggle}
        />
    );
}

/**
 * The ordinary 240×72 card: what it walks, what it calls each item, how many
 * steps are inside — and the way in to see them: the icon tile. The 72px card
 * has no room for a separate Expand link, and the tile is already the one
 * thing on the card that says "this is a loop".
 */
function CollapsedLoop({ id, step, runStep, issues, onAddAfter, friendlyOver, onToggle }) {
    const { t } = useTranslation();
    const overRef = step.overRef || '';
    const itemVar = step.itemVar || 'item';
    const max = step.maxIterations ?? 100;
    const batchSize = step.batchSize ?? 1;
    const bodyLen = Array.isArray(step.body) ? step.body.length : 0;


    // Two connectable ports (mirrors condition/switch's multi-port pattern):
    //   - "Done" fires once after every item has run (the continuation edge);
    //   - "On error" routes a loop failure — branchFromHandle maps this port
    //     to `label: 'on_error'`.
    // The per-item side is not a port: the body is not wired to the loop, it is
    // held by it. Expanding the node draws it.
    // The two labels travel as DATA into StepNodeBase (which renders them as
    // text beside the ports), so the i18n guard cannot see them from the call
    // site — the keys are reported by hand.
    const sourceHandles = [
        { id: 'done', label: t('routines.canvas.loop_port_done', 'Done'), tone: 'then' },
        { id: 'on_error', label: t('routines.canvas.loop_port_on_error', 'On error'), tone: 'error' },
    ];

    // The `· ×{batch}` tail used to be a ternary INSIDE the string, which puts
    // the sentence's shape in JavaScript where no dictionary can reach it. Two
    // complete sentences, chosen by key, instead.
    const sub = friendlyOver
        ? (batchSize > 1
            ? t('routines.canvas.loop_over_batched', 'over: {list} · as loop.{item} · ×{batch}', { list: friendlyOver, item: itemVar, batch: batchSize })
            : t('routines.canvas.loop_over', 'over: {list} · as loop.{item}', { list: friendlyOver, item: itemVar }))
        : { muted: t('routines.canvas.loop_no_list', 'no list yet · as loop.{item}', { item: itemVar }) };

    const badges = (
        <>
            {/* Plural by KEY, not by appending an "s": `step${plural}` is
                grammar written in JavaScript, which no dictionary can undo —
                Dutch does not pluralise this word the same way, and a language
                with three number forms cannot be reached at all. The expanded
                card next door has always done it this way; this chip was the
                one that had not caught up, on the same pair of keys.

                The word "inside" belongs to the SENTENCE, not to the JSX: left
                loose beside the count it stayed English while the number
                translated. Its own key pair, so the whole clause moves at once.
                The expanded card's count is a different sentence (no "inside")
                and keeps `loop_body_step*`. */}
            <NodeChip title={t('routines.canvas.loop_body_title', 'Steps that run per item — expand the node to see them')}>
                ▸ {bodyLen === 1
                    ? t('routines.canvas.loop_body_inside', '{n} step inside', { n: bodyLen })
                    : t('routines.canvas.loop_body_inside_plural', '{n} steps inside', { n: bodyLen })}
            </NodeChip>
            <NodeChip title={t('routines.canvas.loop_max_title', 'Max iterations')}>≤{max}</NodeChip>
        </>
    );

    return (
        <StepNodeBase
            icon={<Repeat size={14} />}
            typeLabel={nodeTypeLabel('loop', t)}
            help={nodeHelp('loop', t)}
            name={step.label || nodeDefaultLabel('loop', t)}
            sub={sub}
            subTitle={overRef || undefined}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
            sourceHandles={sourceHandles}
            onTileClick={onToggle}
            tileLabel={t('routines.canvas.loop_expand', 'Expand — show the steps that run per item here on the canvas')}
        />
    );
}

/**
 * The container: the body drawn inside the loop that runs it.
 *
 * Sized by DiagramPane (node.style), so this fills 100% and draws only chrome —
 * the body is the space its children occupy. Dashed in the loop family colour
 * with a 5% wash (design 1a: "Lus · per bank · 2 stappen"); a run status
 * paints the border solid in the status colour, the same rule as a card.
 *
 * Both ports sit on the header strip rather than the box's vertical middle: on
 * a tall container the middle is nowhere near where the eye expects the flow to
 * leave, and "Done" leaving from beside the title reads as "after all this".
 */
function ExpandedLoop({ id, step, runStep, friendlyOver, onToggle }) {
    const { t } = useTranslation();
    const itemVar = step.itemVar || 'item';
    const batchSize = step.batchSize ?? 1;
    const max = step.maxIterations ?? 100;
    const bodyLen = Array.isArray(step.body) ? step.body.length : 0;
    // The status colour comes from the same table the cards use
    // (nodeTypeColors → shared/statusTokens), not from a ladder of its own:
    // this one knew three statuses, painted `running` amber where a card two
    // pixels away now paints it blue, and had nothing to say about a loop
    // parked on an approval. Null for the quiet states, and then the loop
    // keeps its dashed family border.
    const statusColor = statusVar(runStep?.status);
    const border = statusColor ? `2px solid ${statusColor}` : `1.5px dashed ${typeColorVar('loop')}`;
    const portClass = '!w-3 !h-3 !bg-[var(--bg-primary)] !border-2 !border-[var(--text-tertiary)]';
    return (
        <div
            className="w-full h-full rounded-2xl relative"
            style={{ border, background: typeTint('loop', 5) }}
        >
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
                    <Repeat size={12} className="inline-block align-[-2px] mr-1" />
                    {/* "Loop · per bank · 2 steps" (design 1a). The middle
                        clause is the loop's own item name — the word the steps
                        inside bind against, and the one thing that says WHAT
                        one pass of this container is. */}
                    {nodeTypeLabel('loop', t)}
                    {' · '}
                    {t('routines.canvas.loop_per_item', 'per {item}', { item: itemVar })}
                    {' · '}
                    {bodyLen === 1
                        ? t('routines.canvas.loop_body_step', '{n} step', { n: bodyLen })
                        : t('routines.canvas.loop_body_step_plural', '{n} steps', { n: bodyLen })}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold truncate">{step.label || nodeDefaultLabel('loop', t)}</div>
                    {/* One sentence per key, not a stem with a ternary tail
                        welded on: the batch clause sits in the middle here, and
                        a language that orders it differently has to be able to
                        say so. */}
                    <div className="text-[10px] text-[var(--text-tertiary)] truncate">
                        {batchSize > 1
                            ? t('routines.canvas.loop_over_summary_batched', 'over {list} · as loop.{item} · ×{batch} · ≤{max}', { list: friendlyOver || '—', item: itemVar, batch: batchSize, max })
                            : t('routines.canvas.loop_over_summary', 'over {list} · as loop.{item} · ≤{max}', { list: friendlyOver || '—', item: itemVar, max })}
                    </div>
                </div>
                {/* Body steps are deliberately not recorded per iteration
                    (execLoop passes recordSteps:false — each pass would collide
                    on the run/step key), so the cards inside never light up.
                    Say so once here rather than leaving the user to wonder. */}
                <span
                    title={t('routines.canvas.loop_not_recorded_title', "Steps inside a loop aren't recorded one by one — the loop itself carries the run status.")}
                    className="shrink-0 text-[10px] text-[var(--text-tertiary)] hidden sm:inline"
                >
                    {t('routines.canvas.loop_not_recorded', "per-item steps aren't recorded")}
                </span>
                {onToggle && (
                    <button
                        type="button"
                        onClick={onToggle}
                        title={t('routines.canvas.loop_collapse', 'Collapse — back to a single card')}
                        className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                        <ChevronDown size={15} />
                    </button>
                )}
            </div>
            {/* Same two ports the collapsed card offers, so an existing Done /
                On error connection keeps its anchor while the node is open. */}
            <Handle type="source" position={Position.Right} id="done"
                style={{ top: CONTAINER_HEADER / 2 - 8 }} className={portClass} />
            <Handle type="source" position={Position.Right} id="on_error"
                style={{ top: CONTAINER_HEADER / 2 + 10 }} className={portClass} />
            <span className="hidden" data-node-id={id} />
        </div>
    );
}
