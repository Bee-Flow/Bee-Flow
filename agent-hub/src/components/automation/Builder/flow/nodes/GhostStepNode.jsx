import { Handle, Position } from '@xyflow/react';
import { Check, FileText, GitBranch, ListChecks, Pencil, Play, Search } from 'lucide-react';
import React from 'react';
import IntegrationLogo from './IntegrationLogo';
import useTranslation from '../../../../../hooks/useTranslation';
import { typeGroupOf, typeTileStyle } from '../nodeTypeColors';
import { flightGlyphFor } from '../ribbonOrigin';

/**
 * The ghost slot — where the AI's NEXT card will land while it builds.
 *
 * Synthetic and canvas-only, like the row label: placed by
 * flow/useBuildChoreography.js one column ahead of the frontier card (or on
 * the first column of the next row), tethered to it with the AI-tool edge,
 * never written to the definition and stripped from every operation that
 * expects a step. It exists to fill the 5–15 s silences between tool calls:
 * three bouncing dots say "still working", and one short caption says what
 * the model is working on — a narrated summary of its current thoughts when
 * one has arrived, else the first open todo, else a neutral line. The raw
 * reasoning never appears here; the owner said it "says little to most
 * users".
 *
 * The caption re-wipes each time it changes (the same steps(24) wipe the
 * summary line of a fresh card uses) by remounting on its text. The wipe is
 * inline rather than a stylesheet rule because the node only exists in
 * choreographed mode: with the OS "reduce motion" setting on, the hook never
 * emits a ghost, so there is no static state to zero out.
 *
 * With `data.draft` (flow/ghostDraft.js — the tool call the model is TYPING,
 * read off the streamed arguments) the slot solidifies a little and becomes
 * the card being drawn: the family tile with the app's logo or the kind's
 * icon, the name as far as it has been typed with a blinking caret, and the
 * card's place in its batch. The name updates IN PLACE — a remount per
 * character would restart the wipe on every keystroke — so only the
 * placeholder captions ("Placing Gmail…") keep the wipe. Still no --accent:
 * the one accent on the canvas is the frontier card.
 */
const DOT_DELAYS_MS = [0, 150, 300];

/** The kind's icon for a draft that is an activity, not a card. */
const ACTIVITY_ICON = {
    inspect: Search,
    testing: Play,
    planning: ListChecks,
    summarising: FileText,
    finalizing: Check,
    wiring: GitBranch,
    editing: Pencil,
};

const FRAME = { width: 240, height: 72, borderRadius: 12, background: 'transparent' };

function Dots({ className = '' }) {
    return (
        <span className={`flex items-center gap-1 ${className}`} aria-hidden="true">
            {DOT_DELAYS_MS.map((delay) => (
                <span
                    key={delay}
                    className="animate-bounce"
                    style={{ width: 4, height: 4, borderRadius: 999, background: 'var(--text-tertiary)', animationDelay: `${delay}ms` }}
                />
            ))}
        </span>
    );
}

function DraftTile({ draft }) {
    const isStep = draft.kind === 'step';
    const glyph = isStep ? flightGlyphFor({ type: draft.type, tool: draft.tool, appId: draft.app?.id }) : null;
    const family = isStep ? (typeGroupOf(draft.type) || (draft.app ? 'app' : null)) : null;
    const { tile, glyph: glyphStyle } = typeTileStyle(family, { type: isStep ? draft.type : null });
    const Icon = isStep ? glyph?.icon : ACTIVITY_ICON[draft.kind];
    const fallback = Icon ? <Icon size={16} /> : null;
    return (
        <span style={tile} aria-hidden="true" data-testid="ghost-step-tile" data-family={family || undefined}>
            <span style={glyphStyle}>
                {draft.app
                    ? <IntegrationLogo integrationId={draft.app.id} tool={draft.tool} size={16} fallback={fallback} />
                    : fallback}
            </span>
        </span>
    );
}

function DraftGhost({ draft }) {
    const label = typeof draft.label === 'string' && draft.label.trim() ? draft.label.trim() : null;
    const caption = typeof draft.caption === 'string' && draft.caption.trim() ? draft.caption.trim() : null;
    return (
        <div
            className="pointer-events-none select-none flex items-center gap-2.5 px-3"
            style={{
                ...FRAME,
                borderWidth: 1.5,
                borderStyle: 'solid',
                borderColor: 'color-mix(in srgb, var(--border-default) 60%, transparent)',
                opacity: 0.85,
                color: 'var(--text-primary)',
            }}
            data-testid="ghost-step"
            data-draft-kind={draft.kind}
        >
            <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0, left: -6 }} />
            <DraftTile draft={draft} />
            <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                {label ? (
                    <span className="flex items-center min-w-0 text-[13px] font-medium leading-[17px]" title={label}>
                        <span className="truncate" data-testid="ghost-step-label">{label}</span>
                        {draft.partial && <span className="bf-caret shrink-0" aria-hidden="true" data-testid="ghost-step-caret" />}
                    </span>
                ) : (
                    <span
                        key={caption || ''}
                        className="bf-rv-sub max-w-full truncate text-[12px] italic leading-[16px] text-[var(--text-secondary)]"
                        style={{ animation: 'bfSubWipe 380ms steps(24) both' }}
                        title={caption || undefined}
                        data-testid="ghost-step-caption"
                    >
                        {caption}
                    </span>
                )}
                <span className="flex items-center gap-2 min-w-0 text-[10px] leading-[14px] text-[var(--text-tertiary)]">
                    <Dots />
                    {draft.typeLabel && <span className="truncate uppercase tracking-wide" data-testid="ghost-step-kind">{draft.typeLabel}</span>}
                    {draft.stepOf && <span className="shrink-0 tabular-nums" data-testid="ghost-step-pill">{draft.stepOf}</span>}
                </span>
            </div>
        </div>
    );
}

export default function GhostStepNode({ data }) {
    const { t } = useTranslation();
    if (data?.draft && typeof data.draft === 'object') return <DraftGhost draft={data.draft} />;
    const caption = typeof data?.caption === 'string' && data.caption.trim() ? data.caption.trim() : null;
    const text = caption || t('automations.canvas.build_next', 'Working on the next step…');
    return (
        <div
            className="pointer-events-none select-none flex flex-col items-center justify-center gap-1.5 px-4"
            style={{ ...FRAME, border: '1.5px dashed var(--border-default)', opacity: 0.7 }}
            data-testid="ghost-step"
        >
            {/* The tether needs somewhere to land; the dot itself is invisible. */}
            <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0, left: -6 }} />
            <Dots />
            <span
                key={text}
                className="bf-rv-sub max-w-full truncate text-[11px] italic leading-[14px] text-[var(--text-tertiary)]"
                style={{ animation: 'bfSubWipe 380ms steps(24) both' }}
                title={text}
                data-testid="ghost-step-caption"
            >
                {text}
            </span>
        </div>
    );
}
