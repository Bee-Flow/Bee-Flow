/**
 * Where a run is, as the web builder reads it: the generated copy of
 * agent-hub's Builder/runs/runPhase.ts (mirror/, never edited by hand; see
 * scripts/shared-mirror.manifest.json), plus what the phone says about a pause.
 *
 * It sits in shared/ because two features branch on it, automations (the run
 * screen's actions) and flow-editor (the line over the flow), and
 * features/runs, which held it first, imports automations: reading it from
 * there would close an import cycle.
 */

export { RUN_PHASES, RUN_PHASE_LABELS, runPhase, type RunPhase, type RunPhaseInput, type RunPhaseName } from './mirror/runPhase';
export { runPause, type RunPause, type RunPauseFacts, type WaitingOn } from './runPause';
