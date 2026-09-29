import React, { useState } from 'react';
import { Handle, Position, useStore } from '@xyflow/react';
import { Plus, Play, Pin, PinOff, Loader2, Repeat, Copy as CopyIcon, Trash2, Unlink } from 'lucide-react';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { StepIcon } from '../stepIcons';
import { cardChrome, cardHeightForPorts, typeColorVar, typeTileStyle, CARD_W, PORT_PAD, PORT_PITCH } from '../nodeTypeColors';
import { describeStepResult } from '../stepResultChip';
import { humanizeIssueText } from '../displayHelpers';
import { useZoomLod, LOD_FAR, LOD_NEAR } from '../useZoomLod';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * Shared chrome for every step-type node — the 240×72 card of the Bee Flow
 * Builder redesign (Sep 2026, artboard 1g).
 *
 * Per-type files supply `icon`, `typeLabel`, `name`, `sub` and optional
 * right-corner `badges`. Everything else — the family colour, the step
 * number, the run status, the selection ring, the pin — the card derives
 * itself from NodeRuntimeContext and React Flow's own store, so the 36 node
 * files never have to know about it.
 *
 * Anatomy, left to right:
 *   - a 4px bar in the step's FAMILY colour (inset box-shadow, never a
 *     border-left — the border belongs to the run status);
 *   - a 34px icon tile tinted in the family colour, whose SHAPE encodes the
 *     family a second time (form = circle, Privacy Shield = shield, branch =
 *     45° diamond, end = solid ink);
 *   - a kicker in the family colour (`AI STEP · 7`), the name (13/17) and one
 *     summary line (11/14);
 *   - one badge slot: the run status when there is one, otherwise whatever
 *     the type has to say (an AI step's tier, a form page's wait).
 *
 * Status ALWAYS beats type: the border and a 4px ring carry the run status,
 * a running card also gets a pulsing 3px outline, selection paints a 2px ink
 * border. All of it comes from one function, `cardChrome`, so the card, the
 * minimap and the legend cannot disagree.
 *
 * The action chrome (run-to-here / duplicate / disconnect / pin / delete)
 * sits 8px above the card and appears on hover, on keyboard focus and on a
 * touch tap — driven by React state rather than `group-hover` so it can be
 * asserted in a test. The same five actions answer to R / D / U / P / Del on
 * the selected card (the listener lives in DiagramPane).
 */
export default function StepNodeBase({
    icon, typeLabel = null, help = null,
    // The name (13px semibold) and the one-line summary under it. `sub` is a
    // string, `{ muted }` for the "not answered yet" state (italic, tertiary —
    // what the retired summary-line component rendered), or a React node for the few cards
    // that show chips there (a schedule's cadence, a trigger's params).
    name = null, sub = null, subTitle = undefined,
    // Deprecated: the pre-redesign free-form slot. Rendered in place of
    // name/sub while a node file has not been converted, so the migration can
    // land file by file.
    body = null,
    badges = null,
    // Accepted and ignored — see the pre-redesign history: the popover that
    // rendered it covered the neighbouring cards.
    hoverDetail: _hoverDetail = null,
    runStep, issues, dim = false,
    nodeId = null, onAddAfter = null,
    // Branch steps pass `{ id, label, tone }[]` so each branch gets its own
    // connectable output port; omitted = the single source handle.
    sourceHandles = null,
    // false = the source handle stays (legacy edges keep their anchor) but
    // refuses NEW connections — stop_error.
    sourceConnectable = true,
    // `{ handleId, label, hint, active }` — the AI step's tool port under the
    // card. A labelled, always-visible drop zone, not a bare handle.
    bottomPort = null,
    // Overrides for what the runtime context would otherwise supply — a
    // read-only inspector or a test can name the family and type directly.
    family: familyProp = null, stepType: stepTypeProp = null,
    // 'error' paints the bar, tile and kicker in --error (Stop with an error).
    tone = null,
    // Clicking the icon tile does something (expand a container). Renders the
    // tile as a button with this aria-label.
    onTileClick = null, tileLabel = null,
    // A CSS colour that tints the icon tile instead of the family colour: an
    // AI step that applies a skill without an agent wears --kind-skill.
    tileColor = null,
    // Chips under the card, left of the tool port (an AI step's agent, skill
    // and knowledge). Each chip is its own control; the row is hidden far out.
    portsRow = null,
}) {
    const { t } = useTranslation();
    // Level of detail by zoom (flow/useZoomLod.js): `far` shows shape, family
    // and status only; `mid` adds the name; `near` is the whole card. The box
    // stays 240×72 at every level — only the contents change — so edge anchors
    // and the layout never move when the user zooms.
    const lod = useZoomLod();
    const far = lod === LOD_FAR;
    const near = lod === LOD_NEAR;
    const branchHandles = Array.isArray(sourceHandles) && sourceHandles.length > 0 ? sourceHandles : null;

    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [tapped, setTapped] = useState(false);
    const chromeShown = hovered || focused || tapped;
    const chromeVisibility = chromeShown
        ? 'opacity-100 transition-opacity duration-150'
        : 'opacity-0 pointer-events-none transition-opacity duration-150';

    const rt = useNodeRuntime();
    const pinned = nodeId ? rt.pinnedById?.has?.(nodeId) : false;
    const disabled = nodeId ? rt.disabledById?.has?.(nodeId) : false;
    const customIconName = nodeId ? rt.customIconById?.get?.(nodeId) : null;
    const onExecuteStep = rt.onExecuteStep;
    const executingThis = nodeId && rt.executingStepId === nodeId;
    const runInFlight = !!rt.runInFlight;
    const runIndex = nodeId ? rt.runIndexById?.get?.(nodeId) : null;
    const runTotal = rt.runTotal ?? null;
    const highlighted = nodeId && rt.highlightedStepId === nodeId;
    const errCount = issues?.errors?.length || 0;
    const warnCount = issues?.warnings?.length || 0;
    const status = runStep?.status;

    // The family and the step number — computed once per canvas in
    // DiagramPane's runtime context, so no node file has to pass them.
    const family = familyProp || (nodeId ? rt.typeGroupById?.get?.(nodeId) : null) || null;
    const stepType = stepTypeProp || (nodeId ? rt.stepTypeById?.get?.(nodeId) : null) || null;
    const stepNumber = nodeId ? rt.stepNumberById?.get?.(nodeId) : null;
    const errorTone = tone === 'error';

    // Selection straight from React Flow's store: a boolean selector, so the
    // card re-renders only when ITS selection flips — not on every pan, and
    // not on every other node's selection. No prop, no context, no node-file
    // change needed.
    const selected = useStore((s) => !!(nodeId && s.nodeLookup?.get?.(nodeId)?.selected));
    // The author's own step names, read from the same store for the same
    // reason: flow/layout.js already puts `stepLabelById` (buildStepLabelMap —
    // the very map the canvas validation pill humanises with) on every node's
    // data, so the card can pick it up without all 36 node files threading one
    // more prop through to here.
    const stepLabelById = useStore((s) => (nodeId ? s.nodeLookup?.get?.(nodeId)?.data?.stepLabelById : null) || null);
    // While the drawer edits a step (design 1h): the edited card reads as
    // selected, its direct source is drawn dashed in the family colour with
    // "· source" in the kicker, and what comes next is dimmed.
    const editing = !!nodeId && rt.editingStepId === nodeId;
    const isSource = nodeId ? !!rt.editingSourceIds?.has?.(nodeId) : false;
    const isTarget = nodeId ? !!rt.editingTargetIds?.has?.(nodeId) : false;

    const isPrimaryTrigger = nodeId && rt.primaryTriggerId === nodeId;
    const isAnyTrigger = nodeId ? !!rt.triggerIds?.has?.(nodeId) : false;
    const showDelete = !!rt.onDeleteNode && !!nodeId && !isPrimaryTrigger && !rt.undeletableIds?.has?.(nodeId);
    const showDuplicate = !!rt.onDuplicateNode && !!nodeId && !isAnyTrigger;
    const showDetach = !!rt.onDetachNode && !!nodeId && !isAnyTrigger && !!rt.attachedIds?.has?.(nodeId);
    // Pin needs a captured output to freeze (or an existing pin to release).
    // A trigger never has a run row, so it never gets the button.
    const pinnable = nodeId ? !!rt.pinnableIds?.has?.(nodeId) : false;
    const showPin = !!rt.onPinNode && !!nodeId && !isAnyTrigger && (pinnable || pinned);

    const chrome = cardChrome({
        group: family, type: stepType, status, pinned, disabled, selected: selected || editing, error: errorTone,
    });
    const { tile: tileStyle, glyph: glyphStyle } = typeTileStyle(family, { type: stepType, error: errorTone });
    if (tileColor && !errorTone) {
        tileStyle.background = `color-mix(in srgb, ${tileColor} 16%, transparent)`;
        tileStyle.color = tileColor;
    }
    if (far) {
        // Zoomed out, the tile IS the card: 48px, and the glyph grows with it.
        tileStyle.width = 48;
        tileStyle.height = 48;
        if (tileStyle.borderRadius === 9) tileStyle.borderRadius = 12;
        glyphStyle.width = 20;
        glyphStyle.height = 20;
    }
    const familyColor = errorTone ? 'var(--error)' : typeColorVar(family);
    const glyphSize = far ? 20 : 16;

    const glyph = customIconName
        ? <StepIcon name={customIconName} size={glyphSize} fallback={icon} />
        : (React.isValidElement(icon) ? React.cloneElement(icon, { size: glyphSize }) : icon);

    const handleClass = [
        '!w-3 !h-3 !rounded-full !border-2',
        '!bg-[var(--bg-primary)] !border-[var(--text-tertiary)]',
        chromeShown ? '!opacity-100' : '!opacity-0',
        'transition-opacity duration-150',
        'hover:!border-[var(--text-primary)] hover:!scale-110',
    ].join(' ');

    // More than two output ports: the card grows a row per port (nodeTypeColors).
    const cardH = cardHeightForPorts(branchHandles ? branchHandles.length : 0);
    const cardStyle = {
        width: CARD_W,
        height: cardH,
        boxSizing: 'border-box',
        background: 'var(--bg-card)',
        display: 'flex',
        alignItems: 'center',
        gap: far ? 12 : 10,
        padding: far ? '0 12px 0 16px' : (branchHandles ? '0 30px 0 14px' : '0 10px 0 14px'),
        ...chrome.style,
    };
    if (dim && cardStyle.opacity === 1) cardStyle.opacity = 0.7;
    if (isSource && !selected && !status) cardStyle.border = `2px dashed ${familyColor}`;
    if (isTarget && !editing && cardStyle.opacity === 1) cardStyle.opacity = 0.7;

    const badgeText = chrome.badge
        ? `${t(chrome.badge.key, chrome.badge.en)}${status === 'running' && runIndex != null && runTotal != null ? ` ${runIndex}/${runTotal}` : ''}`
        : null;

    // What the step PRODUCED, once its row has settled (flow/stepResultChip.js):
    // "3 items", "done", "failed". Sits at the head of the summary line at mid
    // and near LOD — the card keeps its 72px, the summary truncates beside it.
    // Null while running (the badge already says so) and with no row at all,
    // so a card without a run renders exactly as before.
    const resultText = describeStepResult(runStep, t);
    // Keyed on its text: a new result remounts the chip and its wipe plays
    // again (`.bf-result-chip`, index.css). Wraps the summary line in a row
    // only when there IS a chip, so the card's markup is untouched otherwise.
    const resultChip = resultText ? (
        <span
            key={resultText}
            className="bf-result-chip shrink-0 text-[10px] leading-[14px] font-semibold tabular-nums whitespace-nowrap text-[var(--text-tertiary)]"
            data-testid="node-result-chip"
        >
            {resultText}
        </span>
    ) : null;
    const withResultChip = (subEl) => (resultChip
        ? <div className="flex items-baseline gap-1.5 min-w-0" data-testid="node-sub-row">{resultChip}{subEl}</div>
        : subEl);

    // ── Build choreography (flow/useBuildChoreography.js) ───────────────
    // While the AI builds, the card wears ONE presentation flag on its root:
    // `fresh` (revealing, after --bf-reveal-delay), `touched` (a family wash +
    // the summary line re-wipes) or `live` (the frontier — the only --accent
    // outline on the canvas). It is a separate attribute, never a status word:
    // the status vocabulary is closed (shared/statusTokens.ts), and index.css
    // selects the live outline with `[data-build=live]:not([data-status])`, so
    // a running card keeps cardChrome's own outline and this steps aside. The
    // check here mirrors that selector so the attribute is not even written
    // when it could not show — a dry run mid-build owns the canvas.
    const fx = nodeId ? rt.buildFxById?.get?.(nodeId) : null;
    const live = !!nodeId && rt.frontierId === nodeId;
    const buildState = fx?.kind || ((live && !status && !runInFlight) ? 'live' : undefined);
    // The delay is a <time> because it sits inside calc() in the stylesheet;
    // the ring is the family colour so a fresh card announces its identity
    // before its kicker is legible.
    const rootStyle = buildState
        ? { ...cardStyle, '--bf-reveal-delay': `${fx?.delayMs ?? 0}ms`, '--bf-ring': familyColor }
        : cardStyle;

    const subIsMuted = sub != null && typeof sub === 'object' && !React.isValidElement(sub) && 'muted' in sub;
    const subText = subIsMuted ? sub.muted : sub;

    const actionBtn = 'h-6 w-6 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed';

    /**
     * What a screen reader says when the card takes focus.
     *
     * The card's visible name first, then its type — "Mail the invoice,
     * Send e-mail" — because the name is what distinguishes one step from the
     * next and a list of eleven "Send e-mail"s is no list at all. Falls back
     * to the type alone for a card that has no name yet, and to a plain word
     * for one that has neither: a focusable element with no accessible name
     * is announced as "button", which tells nobody anything.
     *
     * Deliberately NOT the summary line: it is often a whole sentence, and it
     * changes as the step is edited, so reading it on every focus turns Tab
     * into a monologue. Whoever wants it can read the card.
     */
    const a11yLabel = [
        typeof name === 'string' ? name.trim() : '',
        typeof typeLabel === 'string' ? typeLabel.trim() : '',
    ].filter(Boolean).join(', ') || t('routines.builder.node_generic', 'Step');

    return (
        <div
            className={`group relative cursor-pointer outline-none ${highlighted ? 'animate-[pulse_1s_ease-in-out_2]' : ''}`}
            style={rootStyle}
            data-family={family || undefined}
            data-status={status || undefined}
            data-build={buildState}
            tabIndex={0}
            /* The card has been Tab-reachable since the redesign and there was
               no way to OPEN it from the keyboard: a step is opened by React
               Flow's `onNodeClick` (DiagramPane), which is a mouse event on
               the wrapper this div sits inside. So a keyboard-only user could
               reach every step on the canvas and enter none of them — the
               five action buttons above are individually reachable, but the
               step itself, the thing the whole canvas is for, was not.

               Enter and Space click the card, which is what a `role="button"`
               promises, and the click bubbles to the wrapper so React Flow's
               own handler runs — no second code path that could drift from
               what a mouse does. Key events from a control INSIDE the card
               (an action button, the tile) are left alone; they have their
               own handlers and re-opening the step under them is not what
               was asked. */
            role="button"
            aria-label={a11yLabel}
            onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
                if (e.target !== e.currentTarget) return;
                // Space scrolls the canvas otherwise, and Enter on a card that
                // is about to open should not also submit anything around it.
                e.preventDefault();
                e.currentTarget.click();
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
            onPointerUp={(e) => { if (e.pointerType === 'touch') setTapped(v => !v); }}
        >
            <Handle type="target" position={Position.Left} className={handleClass} style={{ left: -6 }} />
            {branchHandles ? (
                // One source port per branch, stacked down the right edge, each
                // with an always-visible label pill that overlaps the card's
                // edge (design 1a: `ja · 1 record` / `nee · 0`).
                branchHandles.map((h, i) => {
                    // Two ports spread over the card; three or more sit on
                    // their own 22px rows, which is what the card grew for.
                    const top = branchHandles.length > 2
                        ? PORT_PAD + PORT_PITCH * (i + 0.5)
                        : `${((i + 1) / (branchHandles.length + 1)) * 100}%`;
                    return (
                        <React.Fragment key={h.id}>
                            <Handle
                                type="source"
                                id={h.id}
                                position={Position.Right}
                                className={handleClass}
                                style={{ right: -6, top }}
                            />
                            {!far && (
                                <span
                                    className="absolute pointer-events-none -translate-y-1/2 max-w-[120px] truncate text-[10px] font-bold leading-3 px-2 py-0.5 rounded-full"
                                    style={{ left: 'calc(100% - 24px)', top, ...branchToneStyle(h.tone, familyColor) }}
                                    title={h.label}
                                >
                                    {h.label}
                                </span>
                            )}
                        </React.Fragment>
                    );
                })
            ) : (
                <Handle type="source" position={Position.Right} className={handleClass} style={{ right: -6 }} isConnectable={sourceConnectable} />
            )}

            {/* The AI step's tool port: a labelled drop zone under the card in
                the family colour. `data-tool-port` is what the ribbon's drop
                hit-test looks for (flow/stepDrag.js). NOT pointer-events-none:
                `elementFromPoint` skips such elements, and this IS the target. */}
            {bottomPort && nodeId && (
                <>
                    <Handle
                        type="source"
                        id={bottomPort.handleId}
                        position={Position.Bottom}
                        isConnectable={false}
                        className="!w-2.5 !h-2.5 !rounded-full !border-2 !bg-[var(--bg-primary)] !border-[var(--text-tertiary)] !opacity-70"
                        style={{ bottom: -5 }}
                    />
                    {!far && (() => {
                        const toolChip = (
                            <span
                                data-tool-port={nodeId}
                                title={bottomPort.hint || undefined}
                                className={`${portsRow ? 'relative' : 'absolute left-1/2 -translate-x-1/2 z-10'} inline-flex items-center gap-1 px-2 text-[10px] font-semibold whitespace-nowrap leading-4`}
                                style={{
                                    bottom: portsRow ? undefined : -17,
                                    borderRadius: '0 0 8px 8px',
                                    border: `1px solid ${bottomPort.active ? 'var(--text-primary)' : familyColor}`,
                                    borderTop: 0,
                                    background: bottomPort.active ? 'var(--bg-tertiary)' : 'var(--bg-card)',
                                    color: bottomPort.active ? 'var(--text-primary)' : familyColor,
                                }}
                            >
                                {bottomPort.label}
                            </span>
                        );
                        // With a ports row (an AI step's agent / skill /
                        // knowledge), the tool port is the row's last chip.
                        return portsRow ? (
                            <div className="absolute left-1/2 -translate-x-1/2 bottom-[-17px] z-10 flex items-start gap-1" data-testid="node-ports-row">
                                {portsRow}
                                {toolChip}
                            </div>
                        ) : toolChip;
                    })()}
                </>
            )}

            {/* Action chrome — ONE centred row 8px above the card, five actions
                in a fixed order so it never jumps from node to node (BFSF-346).
                R / D / U / P / Del do the same on the selected card. */}
            {(onExecuteStep || showDuplicate || showDetach || showPin || showDelete) && nodeId && (
                <div
                    className={`absolute left-1/2 -translate-x-1/2 flex items-center gap-0.5 px-1 py-0.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm z-[2] ${chromeVisibility}`}
                    style={{ top: -30 }}
                    data-testid="node-hover-toolbar"
                >
                    {onExecuteStep && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onExecuteStep(nodeId, { mode: 'upTo' }); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            disabled={runInFlight || executingThis}
                            title={runInFlight ? 'Run in progress' : 'Run the flow up to here (pinned steps reuse their data) — R'}
                            className={actionBtn}
                            aria-label="Execute step"
                        >
                            {executingThis ? <Loader2 size={12} className="animate-spin" /> : <Play size={11} fill="currentColor" />}
                        </button>
                    )}
                    {showDuplicate && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); rt.onDuplicateNode(nodeId); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            title="Duplicate this step — D"
                            aria-label="Duplicate step"
                            className={actionBtn}
                        >
                            <CopyIcon size={11} />
                        </button>
                    )}
                    {showDetach && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); rt.onDetachNode(nodeId); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            title="Take this step out of the flow (it stays on the canvas, its neighbours reconnect) — U"
                            aria-label="Disconnect step"
                            className={actionBtn}
                        >
                            <Unlink size={11} />
                        </button>
                    )}
                    {showPin && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); rt.onPinNode(nodeId); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            title={pinned ? 'Release the frozen output — P' : 'Freeze the last output so later runs reuse it — P'}
                            aria-label={pinned ? 'Unpin step' : 'Pin step'}
                            className={actionBtn}
                            style={pinned ? { color: 'var(--pinned)' } : undefined}
                        >
                            {pinned ? <PinOff size={11} /> : <Pin size={11} />}
                        </button>
                    )}
                    {showDelete && (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); rt.onDeleteNode(nodeId); }}
                            onMouseDown={(e) => e.stopPropagation()}
                            title="Delete this step (reconnects its neighbours) — Del"
                            aria-label="Delete step"
                            className={`${actionBtn} hover:!text-[var(--error)]`}
                        >
                            <Trash2 size={11} />
                        </button>
                    )}
                </div>
            )}

            {/* Quick-add "+" — past the right handle, filled in the theme ink.
                Suppressed on branch nodes, where "add after" is ambiguous. */}
            {onAddAfter && nodeId && !branchHandles && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onAddAfter(nodeId); }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className={`absolute top-1/2 -translate-y-1/2 -right-7 h-[22px] w-[22px] rounded-full flex items-center justify-center shadow-sm ${chromeVisibility}`}
                    style={{ background: 'var(--text-primary)', color: 'var(--bg-primary)' }}
                    title="Add next step"
                    aria-label="Add next step"
                >
                    <Plus size={13} />
                </button>
            )}

            {/* The icon tile. A button when the type has something to do with
                it (a container expands from here — the 72px card has no room
                for a separate chevron). */}
            {onTileClick ? (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onTileClick(e); }}
                    onMouseDown={(e) => e.stopPropagation()}
                    aria-label={tileLabel || 'Expand'}
                    title={tileLabel || 'Expand'}
                    className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-primary)]"
                    style={tileStyle}
                >
                    <span style={glyphStyle}>{glyph}</span>
                </button>
            ) : (
                <span style={tileStyle} aria-hidden="true">
                    <span style={glyphStyle}>{glyph}</span>
                </span>
            )}

            <div
                className="flex-1 min-w-0 flex flex-col gap-px"
                // Native, so it cannot cover the neighbouring cards or the
                // action chrome. The step's own editor says it properly.
                title={[typeLabel, help].filter(Boolean).join(' — ') || undefined}
            >
                {body && name == null ? (
                    <div className="text-xs text-[var(--text-primary)] leading-snug min-w-0">{body}</div>
                ) : far ? (
                    // Zoomed right out: the NAME, big enough to read at 30%, on up
                    // to two lines. Design 1g showed the family word here; the tile's
                    // colour and glyph already say that, and a title you cannot read
                    // is what the user finds first (feedback 2026-09-03).
                    <div
                        className="text-[22px] font-bold leading-[24px] text-[var(--text-primary)] line-clamp-2 break-words"
                        title={typeLabel || undefined}
                        data-testid="node-far-label"
                    >
                        {name ?? typeLabel}
                        {stepNumber != null && <span className="ml-2 text-[14px] font-medium text-[var(--text-tertiary)]">{stepNumber}</span>}
                    </div>
                ) : !near ? (
                    // Middle distance: the name on up to two lines, the number to
                    // find it by, and the description in one line beneath.
                    <>
                        <div className="text-[16px] font-semibold leading-5 text-[var(--text-primary)] line-clamp-2 break-words" data-testid="node-name">
                            {name ?? typeLabel}
                            {stepNumber != null && <span className="ml-2 text-[12px] font-medium text-[var(--text-tertiary)]" data-testid="node-step-number">{stepNumber}</span>}
                        </div>
                        {(resultChip || (subText != null && subText !== '')) && withResultChip(
                            subText != null && subText !== '' ? (
                                <div className={`text-[12px] leading-[14px] truncate ${subIsMuted ? 'italic text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`} data-testid="node-sub">
                                    {subText}
                                </div>
                            ) : null,
                        )}
                    </>
                ) : (
                    <>
                        {(typeLabel || stepNumber != null) && (
                            <div className="flex items-center gap-1.5 text-[10px] leading-3 font-semibold uppercase tracking-[.06em] whitespace-nowrap overflow-hidden">
                                {typeLabel && <span className="truncate" style={{ color: familyColor }}>{typeLabel}</span>}
                                {stepNumber != null && <span className="shrink-0 text-[var(--text-tertiary)]" data-testid="node-step-number">· {stepNumber}</span>}
                                {isSource && <span className="shrink-0 text-[var(--text-tertiary)]" data-testid="node-source-tag">· {t('routines.card.source', 'source')}</span>}
                            </div>
                        )}
                        <div className="text-[13px] font-semibold leading-[17px] text-[var(--text-primary)] line-clamp-2 break-words" data-testid="node-name">
                            {name ?? typeLabel}
                        </div>
                        {(resultChip || (subText != null && subText !== '')) && withResultChip(
                            subText != null && subText !== '' ? (
                                // `bf-rv-sub` is the wipe-in hook for the build
                                // choreography ("inputs filling in"), near LOD only —
                                // further out the whole card fades instead. Keyed on
                                // the touch time so a second edit remounts the line
                                // and the wipe plays again.
                                <div
                                    key={fx?.touchedAt ?? 'sub'}
                                    className={`bf-rv-sub text-[11px] leading-[14px] truncate ${subIsMuted ? 'italic text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}
                                    title={subTitle || (typeof subText === 'string' ? subText : undefined)}
                                    data-testid="node-sub"
                                >
                                    {subText}
                                </div>
                            ) : null,
                        )}
                    </>
                )}
            </div>

            {/* ONE badge slot: the run status wins; otherwise the type's own.
                Only up close — further out the border and ring already say it.
                In the top-right CORNER, over the border, so the name row keeps
                its full width ("1. Modus be…" was the badge's doing). */}
            {near && (badgeText || badges) && (
                <div className="absolute flex items-center gap-1 max-w-[96px] overflow-hidden" style={{ top: -9, right: 10 }} data-testid="node-badge-slot">
                    {badgeText ? (
                        <span
                            className="text-[10px] font-bold leading-4 px-1.5 rounded-md whitespace-nowrap"
                            style={{ background: chrome.badge.bg, color: chrome.badge.fg }}
                            data-testid="node-status-badge"
                        >
                            {badgeText}
                        </span>
                    ) : badges}
                </div>
            )}

            {/* Validation dot — 12px, outside the bottom-right corner. Two tones
                on purpose: a warning-only node must not read as broken. The
                card itself stays neutral; the message lives in the tooltip and
                in the step editor. */}
            {(errCount > 0 || warnCount > 0) && (
                <span
                    className="absolute rounded-full border-2 border-[var(--bg-primary)]"
                    style={{ right: -5, bottom: -5, width: 12, height: 12, background: errCount > 0 ? 'var(--error)' : 'var(--warning)' }}
                    data-testid="node-validation-dot"
                    data-tone={errCount > 0 ? 'error' : 'warning'}
                    title={validationDotTitle(issues, stepLabelById)}
                />
            )}
        </div>
    );
}

/**
 * What the validation dot says on hover. Two rules, both paid for:
 *
 * The SENTENCE comes first, and it says the names the author gave their steps.
 * The tooltip used to open with the server's validation code
 * (`ai_step.agent_unavailable: …`) — the one token in the line that explains
 * nothing to the person reading it — and the message behind it still carried
 * raw step ids (`Step code_a3f91b: …`) while the canvas pill, one pane away,
 * had already swapped those for labels (FloatingValidationPill →
 * humanizeIssueText). The same failure spoke two languages depending on where
 * you read it, so the author who clicked a pill BECAUSE it named their step
 * landed on a card talking about a hex id and reasonably concluded there were
 * two problems. Same helper on both surfaces now, so they cannot drift again.
 *
 * The CODE stays — demoted to the tail, in parentheses. It is what support
 * asks for, and this tooltip is the only place on the card with room for it;
 * deleting it would cap the power user to serve the beginner.
 */
function validationDotTitle(issues, stepLabelById) {
    return [...(issues?.errors || []), ...(issues?.warnings || [])]
        .map((r) => {
            const sentence = humanizeIssueText(r.message, stepLabelById) || r.message || '';
            return r.code ? `${sentence} (${r.code})` : sentence;
        })
        .join('\n');
}

/**
 * A branch port label. The node's family colour by default (a condition's
 * `match`/`otherwise`, a guard's `personal data`/`clean`), `--error` for an
 * on-error port, and a quiet italic for the catch-all `default`.
 */
function branchToneStyle(tone, familyColor) {
    if (tone === 'error') return { background: 'var(--bg-card)', color: 'var(--error)', border: '1.5px solid var(--error)' };
    if (tone === 'default') return { background: 'var(--bg-card)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)', fontStyle: 'italic' };
    return { background: 'var(--bg-card)', color: familyColor, border: `1.5px solid ${familyColor}` };
}

/** Small reusable chip — used by per-type nodes for tier / channel pills. */
export function NodeChip({ children, tone = 'neutral', title }) {
    const style = tone === 'accent'
        ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }
        : tone === 'warn'
            ? { background: 'color-mix(in srgb, var(--warning) 16%, transparent)', color: 'var(--warning)' }
            : tone === 'danger'
                ? { background: 'color-mix(in srgb, var(--error) 16%, transparent)', color: 'var(--error)' }
                : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };
    return (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold leading-4 px-1.5 rounded-md whitespace-nowrap" style={style} title={title}>
            {children}
        </span>
    );
}

/**
 * The "for each" chip shown when a leaf step iterates over an upstream array
 * via per-step `forEach` (no wrapping loop).
 */
export function ForEachBadge({ step }) {
    if (!step?.forEach?.overRef) return null;
    return (
        <NodeChip tone="accent" title={`Runs once per item in ${step.forEach.overRef}`}>
            <Repeat size={10} /> for each
        </NodeChip>
    );
}

/**
 * Render up to 4 of the resolved input keys (top-level only). Inputs are
 * binding objects (`{kind:'literal',value:…}` etc.) — only the
 * user-meaningful values are shown, not the wrapping kind.
 */
export function renderInputsPreview(inputs) {
    if (!inputs || typeof inputs !== 'object') return null;
    const entries = Object.entries(inputs).slice(0, 4);
    if (entries.length === 0) return null;
    return (
        <div className="mt-1 space-y-0.5">
            {entries.map(([k, v]) => (
                <div key={k} className="truncate">
                    <span className="text-[var(--text-tertiary)]">{k}:</span>{' '}
                    <span className="font-mono text-[10px]">{previewBinding(v)}</span>
                </div>
            ))}
        </div>
    );
}

function previewBinding(v) {
    if (v == null) return '—';
    if (typeof v !== 'object') return String(v).slice(0, 40);
    if (v.kind === 'literal') return JSON.stringify(v.value).slice(0, 40);
    if (v.kind === 'ref') return `→ ${v.path}`;
    if (v.kind === 'template') return `"${(v.value || '').slice(0, 40)}"`;
    if (v.kind === 'expr') return `expr: ${v.value || ''}`;
    return JSON.stringify(v).slice(0, 40);
}
