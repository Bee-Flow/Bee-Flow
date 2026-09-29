import { createContext, useContext } from 'react';

/**
 * App Studio editor — the live build, seen from the canvas.
 *
 * The AI chat pane owns the stream; the canvas draws the film. This is the
 * one-way bridge between them (the sibling of EditorChromeContext, which
 * points the other way): BuilderChatPane publishes a `buildCue` through the
 * shell (`chrome.publishBuildCue`), the shell provides it here, and the
 * canvas reads it for the banner, the ghost cell and the camera.
 *
 * The cue is built ONCE per tool call / plan event / turn milestone, never per
 * streamed token, so the canvas does not re-render on every character:
 *   {
 *     running, startedAt, phase: 'building'|'checking'|'finishing',
 *     lastCall: { name, title, detail, added, ok } | null,   // words of the activity row
 *     todos, phaseInfo, engine, turn, toolDraft,
 *     reveal: { plan, at } | null,                           // what the canvas is dealing
 *     finalized, stopped, skipped, componentCount, screenCount,
 *   }
 * Null when no build is running and no farewell is due.
 *
 * The SCREEN being built is not part of the cue: the canvas resolves it from
 * `toolDraft.parentId` / `lastCall.added` / `reveal` against its live
 * definition (editor/buildScreenTarget.js, inside useBuildFollow), because the
 * pane's memo reads its definition one render late and would miss a screen on
 * the very draft that creates it. The camera and the banner read the same
 * resolution, so they agree by construction.
 */
export const BuildCueContext = createContext(null);

export function useBuildCue() {
    return useContext(BuildCueContext);
}
