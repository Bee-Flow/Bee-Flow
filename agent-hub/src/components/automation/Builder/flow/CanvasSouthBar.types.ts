import React from 'react';
import { type RunFocus } from './runFocus';
import type { BuildTodo } from './useBuildChoreography.types';
import type { ToolCallRow } from '../chat/toolCallDisplay';
import type { BuilderEngine, BuilderTurn } from '../../../../hooks/builderStream';
import type { RunIdentity } from './useFailedRunBanner';

/** Plan progress, only when the model published a plan — "Plan 0/0" is a number the banner invented. */
export interface PlanStripProps {
    todos: BuildTodo[] | null | undefined;
    verb: string | null;
}

/**
 * The engine line (flow/engineLine.js), to the right of the verb: which
 * model, on this machine or not, how far through the prompt, how fast the
 * last round went. Every word a measurement; nothing rendered when there is
 * none. It gives way first: `min-w-0 truncate` lets it shrink to an ellipsis
 * before the banner would ever wrap, and under a large viewport (the panel is
 * capped at the canvas width minus the zoom stack and minimap) it is not
 * drawn at all — the clock and the verb are the facts that must survive a
 * narrow screen. No `--accent` here: the dot already has it, and the pill is
 * a claim, not a live thing.
 */
export interface EngineLineProps {
    engine: BuilderEngine | null;
    turn: BuilderTurn | null;
}

/**
 * The build banner's body. Whether it shows at all is decided in
 * CanvasSouthBar — the precedence chain there needs the marks — so this only
 * renders what it is handed: the live cue while `building`, the frozen
 * `farewell` snapshot after.
 */
export interface BuildBannerProps {
    building: boolean;
    buildCue: SouthBarCue | null;
    farewell: Farewell | null;
    endedAt: number;
    skipped: SouthCall | null;
    now: number;
    following: boolean;
    onFollow: React.MouseEventHandler<HTMLButtonElement> | null;
}

/** The tool call the cue carries: what the activity row in the chat says, plus the refusal. */
export type SouthCall = Partial<ToolCallRow> & { name?: string };

/** The AI build's live cue as the south bar reads it (build/useBuildCue.ts). */
interface SouthBarCue {
    running?: boolean;
    phase?: string;
    startedAt?: number | null;
    lastCall?: SouthCall | null;
    todos?: BuildTodo[] | null;
    finalizedId?: string | null;
    stepCount?: number;
    engine?: BuilderEngine | null;
    turn?: BuilderTurn | null;
}

/** The frozen snapshot of the build that just ended. */
export interface Farewell {
    startedAt: number | null;
    finalizedId: string | null;
    stepCount: number;
}

export interface CanvasSouthBarProps {
    runFocus?: RunFocus | null;
    onDismissRun?: (() => void) | null;
    runIdentity?: RunIdentity | null;
    onShowRun?: (() => void) | null;
    formUrl?: string | null;
    onOpenFormOverlay?: (() => void) | null;
    selectedCount?: number;
    selectionInDrawer?: boolean;
    structuralEditsBlocked?: boolean;
    interactive?: boolean;
    editable?: boolean;
    following?: boolean;
    onDeleteSelection?: (() => void) | null;
    onClearSelection?: (() => void) | null;
    buildCue?: SouthBarCue | null;
    onFollow?: React.MouseEventHandler<HTMLButtonElement> | null;
}
