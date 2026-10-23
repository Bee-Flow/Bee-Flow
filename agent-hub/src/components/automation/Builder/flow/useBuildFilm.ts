import { useMemo } from 'react';
import { spotlightKeysFor } from './ghostDraft';
import { useBuildChoreography } from './useBuildChoreography';
import { useDryRunReplayCamera } from './useDryRunReplayCamera';
import { useReducedMotion } from './useReducedMotion';
import { useRibbonFlight, FLIGHT_TOTAL_MS } from './useRibbonFlight';
import { useRibbonSpotlight } from './useRibbonSpotlight';
import type { RefObject } from 'react';
import type { FlowNode, StepId } from './diagramPaneTypes';
import type { RuntimeContext } from './buildRuntimeContext';

type ChoreographyArgs = Parameters<typeof useBuildChoreography>[0];

// ghostDraft.js is untyped JS whose `= null` default reads as a `null` type.
const spotKeysOf = spotlightKeysFor as (draft: unknown, catalog?: unknown) => string[];

/** The cue BuildTab hands over: the choreography's fields plus what the film also reads. */
type BuildFilmCue = NonNullable<ChoreographyArgs['buildCue']> & {
    running?: boolean;
    lastCall?: { added?: Array<{ id?: string | null } | null> };
    startedAt?: number | null;
};

interface BuildFilmArgs extends Omit<ChoreographyArgs, 'reducedMotion' | 'orderHint' | 'flightMs' | 'buildCue'> {
    buildCue: BuildFilmCue | null;
    ribbonRootRef: RefObject<HTMLElement | null> | null;
    replayStepId: StepId | null;
    absPositionOf: (node: FlowNode | null | undefined) => { x: number; y: number } | null;
    baseRuntimeContext: RuntimeContext;
}

/**
 * The build as a film, and the dry run replayed.
 *
 * While the AI is writing the graph: each draft is diffed into reveal
 * flags for the cards and edges it added or edited, one frontier card
 * carries the --accent outline, a ghost slot ahead of it shows what the
 * model is working on, and the camera follows — pushing in on an arrival
 * that landed off-screen, pulling wide at chapter breaks, and yielding for
 * good the moment the presenter touches the viewport. The choreography lives
 * in flow/useBuildChoreography.ts; with the OS "reduce motion" setting on it
 * reproduces the earlier count-keyed fitView and issues no flags.
 */
export function useBuildFilm({
    ribbonRootRef, replayStepId, absPositionOf, baseRuntimeContext, ...choreography
}: BuildFilmArgs) {
    const { definition, rf, buildCue, catalog } = choreography;
    const reducedMotion = useReducedMotion();
    // The order the model itself dealt a batch in (`builder_add_steps` lists
    // its `added` entries in writing order; BuildTab keeps them on the cue).
    // Keyed on the call, not the cue: the cue is rebuilt per narration phrase.
    const lastCallAdded = buildCue?.lastCall?.added;
    const orderHint = useMemo(
        () => (Array.isArray(lastCallAdded) ? lastCallAdded.map(a => a?.id).filter((id): id is string => id != null) : null),
        [lastCallAdded],
    );
    // With a ribbon on screen every card's reveal waits for its ghost to land
    // (departure + FLIGHT_TOTAL_MS); without one — a read-only canvas, the
    // trigger-picker state — the cards reveal at their departure as before.
    const hasRibbon = !!ribbonRootRef?.current;
    const {
        buildFxById, frontierId, freshEdgeKeys, ghostNodes, ghostEdges,
        onMoveStart, onMoveEnd, following, resumeFollow,
        revealQueue, revealHead, active: buildActive, ghostDraft,
    } = useBuildChoreography({
        ...choreography, reducedMotion, orderHint, flightMs: hasRibbon ? FLIGHT_TOTAL_MS : 0,
    });
    const { ghosts: flightGhosts } = useRibbonFlight({
        queue: revealQueue, head: revealHead, definition, catalog, rf, ribbonRootRef, reducedMotion,
        enabled: buildActive && hasRibbon,
    });

    // The camera centres on the card a replay reveals; a move we did not
    // start while a replay is on hands the camera back to the presenter.
    const onMoveStartGuarded = useDryRunReplayCamera({ replayStepId, following, rf, absPositionOf, onMoveStart });
    // While the model is TYPING an app step (or inspecting an app), the tile
    // it is drawn from wears a steady spotlight — the eye is on the ribbon
    // before the pick ring flashes there at the card's departure.
    const spotKeys = useMemo(() => spotKeysOf(ghostDraft, catalog), [ghostDraft, catalog]);
    useRibbonSpotlight({
        ribbonRootRef, keys: spotKeys,
        enabled: buildActive && hasRibbon && !!buildCue?.running,
    });

    // The flags change once per tool call, never per streamed token, so
    // folding them into the node context re-renders the cards exactly when a
    // card has something new to show.
    const runtimeContextValue = useMemo(
        () => ({ ...baseRuntimeContext, buildFxById, frontierId }),
        [baseRuntimeContext, buildFxById, frontierId],
    );

    return {
        reducedMotion, buildFxById, freshEdgeKeys, ghostNodes, ghostEdges, onMoveEnd, following, resumeFollow,
        flightGhosts, onMoveStartGuarded, runtimeContextValue,
    };
}
