import React, { useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Repeat } from 'lucide-react';
import { stepNodeLook } from './stepNodeLook';
import { AddAfterButton, BadgeSlot, StepActionToolbar, ValidationDot } from './StepNodeChrome';
import { StepNodeText, StepNodeTile } from './StepNodeFace';
import { SourcePorts, ToolPort } from './StepNodePorts';
import { useStepNodeRuntime } from './useStepNodeRuntime';
import { useZoomLod, LOD_FAR, LOD_NEAR } from '../useZoomLod';
import useTranslation from '../../../../../hooks/useTranslation';
import type { Binding, NodeStep, StepNodeBaseProps } from './StepNodeBase.types';
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
    // An optional SECOND summary line (same string / `{ muted }` shapes as
    // `sub`), for a card whose one line would truncate the half that matters:
    // a Condition's list on the first line, its rule on this one. With it the
    // name keeps to one line, so the card keeps its 72px.
    subDetail = null,
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
}: StepNodeBaseProps) {
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

    const errorTone = tone === 'error';
    const status = runStep?.status;
    const r = useStepNodeRuntime({ nodeId, issues, familyProp, stepTypeProp });
    const { rt, family, stepNumber, isSource, errCount, warnCount } = r;
    const { chrome, tileStyle, glyphStyle, familyColor, cardStyle } = stepNodeLook({
        family, stepType: r.stepType, status, pinned: r.pinned, disabled: r.disabled, selected: r.selected, editing: r.editing,
        isSource, isTarget: r.isTarget, errorTone, tileColor, far, dim, branchHandleCount: branchHandles ? branchHandles.length : 0,
    });
    const glyphSize = far ? 20 : 16;

    const handleClass = [
        '!w-3 !h-3 !rounded-full !border-2',
        '!bg-[var(--bg-primary)] !border-[var(--text-tertiary)]',
        chromeShown ? '!opacity-100' : '!opacity-0',
        'transition-opacity duration-150',
        'hover:!border-[var(--text-primary)] hover:!scale-110',
    ].join(' ');

    const badgeText = chrome.badge
        ? `${t(chrome.badge.key, chrome.badge.en)}${status === 'running' && r.runIndex != null && r.runTotal != null ? ` ${r.runIndex}/${r.runTotal}` : ''}`
        : null;

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
    const buildState = fx?.kind || ((live && !status && !r.runInFlight) ? 'live' : undefined);
    // The delay is a <time> because it sits inside calc() in the stylesheet;
    // the ring is the family colour so a fresh card announces its identity
    // before its kicker is legible.
    const rootStyle = buildState
        ? { ...cardStyle, '--bf-reveal-delay': `${fx?.delayMs ?? 0}ms`, '--bf-ring': familyColor }
        : cardStyle;

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
    ].filter(Boolean).join(', ') || t('automations.builder.node_generic', 'Step');

    return (
        <div
            className={`group relative cursor-pointer outline-none ${r.highlighted ? 'animate-[pulse_1s_ease-in-out_2]' : ''}`}
            style={rootStyle}
            data-family={family || undefined}
            data-status={status || undefined}
            data-build={buildState}
            tabIndex={0}
            /* The card has been Tab-reachable since the redesign and there was
               no way to OPEN it from the keyboard: a step is opened by React
               Flow's `onNodeClick` (DiagramPane), which is a mouse event on
               the wrapper this div sits inside. So a keyboard-only user could
               reach every step on the canvas and enter none of them.

               Enter and Space click the card, which is what a `role="button"`
               promises, and the click bubbles to the wrapper so React Flow's
               own handler runs — no second code path that could drift from
               what a mouse does. Key events from a control INSIDE the card
               (an action button, the tile) are left alone. */
            role="button"
            aria-label={a11yLabel}
            onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
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
            onBlur={(e: React.FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
            onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => { if (e.pointerType === 'touch') setTapped((v: boolean) => !v); }}
        >
            <Handle type="target" position={Position.Left} className={handleClass} style={{ left: -6 }} />
            <SourcePorts branchHandles={branchHandles} handleClass={handleClass} far={far} familyColor={familyColor} sourceConnectable={sourceConnectable} />
            {bottomPort && nodeId && (
                <ToolPort bottomPort={bottomPort} nodeId={nodeId} far={far} familyColor={familyColor} portsRow={portsRow} />
            )}
            <StepActionToolbar
                nodeId={nodeId}
                rt={rt}
                chromeVisibility={chromeVisibility}
                pinned={r.pinned}
                runInFlight={r.runInFlight}
                executingThis={r.executingThis}
                showDuplicate={r.showDuplicate}
                showDetach={r.showDetach}
                showPin={r.showPin}
                showDelete={r.showDelete}
            />
            {/* Suppressed on branch nodes, where "add after" is ambiguous. */}
            {onAddAfter && nodeId && !branchHandles && (
                <AddAfterButton nodeId={nodeId} onAddAfter={onAddAfter} chromeVisibility={chromeVisibility} />
            )}
            <StepNodeTile
                icon={icon}
                customIconName={r.customIconName}
                glyphSize={glyphSize}
                tileStyle={tileStyle}
                glyphStyle={glyphStyle}
                onTileClick={onTileClick}
                tileLabel={tileLabel}
            />
            <StepNodeText
                far={far}
                near={near}
                name={name}
                typeLabel={typeLabel}
                help={help}
                body={body}
                sub={sub}
                subTitle={subTitle}
                subDetail={subDetail}
                runStep={runStep}
                stepNumber={stepNumber}
                isSource={isSource}
                familyColor={familyColor}
                touchedAt={fx?.touchedAt}
            />
            {near && (badgeText || badges) && <BadgeSlot badgeText={badgeText} badge={chrome.badge} badges={badges} />}
            {(errCount > 0 || warnCount > 0) && <ValidationDot issues={issues} errCount={errCount} stepLabelById={r.stepLabelById} />}
        </div>
    );
}


/** Small reusable chip — used by per-type nodes for tier / channel pills. */
export function NodeChip({ children, tone = 'neutral', title }: { children?: React.ReactNode; tone?: string; title?: string }) {
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
export function ForEachBadge({ step }: { step?: NodeStep | null }) {
    const { t } = useTranslation();
    if (!step?.forEach?.overRef) return null;
    return (
        <NodeChip tone="accent" title={`Runs once per item in ${step.forEach.overRef}`}>
            <Repeat size={10} /> {t('automations.step_node_base.for_each', 'for each')}
        </NodeChip>
    );
}

/**
 * Render up to 4 of the resolved input keys (top-level only). Inputs are
 * binding objects (`{kind:'literal',value:…}` etc.) — only the
 * user-meaningful values are shown, not the wrapping kind.
 */
function renderInputsPreview(inputs: unknown) {
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

function previewBinding(v: Binding | string | number | boolean | null | undefined): string {
    if (v == null) return '—';
    if (typeof v !== 'object') return String(v).slice(0, 40);
    if (v.kind === 'literal') return JSON.stringify(v.value).slice(0, 40);
    if (v.kind === 'ref') return `→ ${v.path}`;
    if (v.kind === 'template') return `"${(v.value || '').slice(0, 40)}"`;
    if (v.kind === 'expr') return `expr: ${v.value || ''}`;
    return JSON.stringify(v).slice(0, 40);
}
