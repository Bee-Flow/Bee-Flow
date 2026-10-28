import type { RefObject } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { DiagramDefinition, Rf } from './diagramPaneTypes';

/** A card's layout rect, absolute (parents added back on). */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** One camera cut the film can issue. */
export type ShotKind = 'wide' | 'mount' | 'push' | 'center';

/** A card's presentation flag: fresh (revealing) or touched (summary re-wipes). */
export interface FxEntry {
    kind: 'fresh' | 'touched';
    delayMs: number;
    at: number;
    touchedAt?: number;
}

/** A queued card: its id and the instant its turn begins. */
export interface PendingCard {
    id: string;
    at: number;
}

/** What the camera effect keys on: a new object per applied diff. */
export interface FxEvent {
    seq: number;
    reason: string;
    rowWrapped: boolean;
    touched: string | null;
    at: number;
    burst: number;
}

/** The flag state (see the comment above EMPTY in useBuildChoreography). */
export interface FxState {
    byId: Map<string, FxEntry>;
    edgeKeys: Map<string, number>;
    frontierId: string | null;
    ghostHidden: boolean;
    pending: readonly PendingCard[];
    head: PendingCard | null;
    burst: number;
    event: FxEvent | null;
}

/** What buildChoreography.diffDefinitions reports between two drafts. */
export interface ChoreographyDiff {
    added: string[];
    removed: string[];
    touched: string[];
    addedEdgeKeys: string[];
}

export interface BuildTodo {
    text?: string;
    done?: boolean;
}

/** The AI build's live cue (BuildTab -> DiagramPane). */
export interface BuildCue {
    phase?: string;
    narration?: string | null;
    todos?: BuildTodo[] | null;
    toolDraft?: unknown;
}

/** A queued camera plan. */
export interface CameraPlan {
    moves: ShotKind[];
    holdMs: number;
}

/** What the timers read at fire time, one commit behind at most. */
export interface LatestChoreography {
    rf: Rf;
    wrapperRef: RefObject<HTMLElement | null>;
    computedNodes: Node[];
    definition: DiagramDefinition;
    fx: FxState;
    blocked: boolean;
    active: boolean;
    reducedMotion: boolean;
    orderHint: string[] | null;
    cameraInsetLeft: number;
}

export interface BuildChoreographyArgs {
    definition: DiagramDefinition;
    computedNodes: Node[];
    edges?: Edge[];
    structuralEditsBlocked?: boolean;
    buildCue?: BuildCue | null;
    rf: Rf;
    wrapperRef: RefObject<HTMLElement | null>;
    reducedMotion?: boolean;
    runInFlight?: boolean;
    orderHint?: string[] | null;
    flightMs?: number;
    cameraInsetLeft?: number;
    catalog?: unknown;
    t?: TranslateFn | null;
}

/** buildChoreography.js shotFor, as the film calls it. */
export type ShotForFn = (args: {
    kind?: string;
    rects: Rect[];
    ghostRect?: Rect;
    viewport: { width: number; height: number; offsetX: number } | null;
    current: { x: number; y: number; zoom: number };
}) => { x: number; y: number; zoom: number; duration: number; interpolate: 'smooth' | 'linear' } | null;

/** buildChoreography.js planCameraMove, as the film calls it. */
export type PlanCameraMoveFn = (args: {
    reason: string;
    following?: boolean;
    lastMoveAt?: number | null;
    now?: number;
    rowWrapped?: boolean;
}) => { moves: ShotKind[]; deferMs: number; holdMs: number } | null;

/** ghostDraft.js projectGhostDraft, as the film calls it. */
export type ProjectGhostDraftFn = (toolDraft: unknown, opts?: { catalog?: unknown; t?: TranslateFn | null }) => ReturnType<typeof import('./ghostDraft').projectGhostDraft>;

export interface ApplyDiffOptions {
    definition?: DiagramDefinition | null;
    nodes: Node[];
    now: number;
    orderHint?: string[] | null;
    flightMs?: number;
}

export type { DiagramDefinition, Node, RefObject };
