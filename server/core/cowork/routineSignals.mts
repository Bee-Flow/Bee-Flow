/**
 * "Make it routine": what the last good runs of an agent or prompt item did, in names and counts only, and whether
 * fixed steps are worth proposing. Read from each run's recorded activity (./runActivity.mts: which app actions it
 * called, how often); never from what the pages, mails or results said.
 *
 * The planner (usecases/coworkPlanner.mts) gets these as hints, and makes the fixed steps itself, checked like every
 * plan. ./routineCompare.mts compares a try-out of the proposal with the run it was made from.
 */

interface ToolUse { name?: unknown; app?: unknown; ok?: unknown }
export interface RunLike { status?: string | null; activity?: { tools?: ToolUse[] | null; readOutsideText?: boolean } | null }

export interface ToolHabit { tool: string; app: string | null; inRuns: number; callsPerRun: number }

export interface RoutineSignals {
    /** The good runs it was read from. */
    runs: number;
    /** Every app action those runs used, most used first. */
    habits: ToolHabit[];
    /** The ones every run used: the candidates for a fixed step. */
    steady: ToolHabit[];
    readsOutsideText: boolean;
    /** Enough runs, and something that is the same every time. */
    worthIt: boolean;
}

export const MIN_RUNS = 3;
export const MAX_RUNS = 10;

/** The signals of the newest MAX_RUNS good runs that recorded what they did. */
export function routineSignals(runs: RunLike[]): RoutineSignals {
    const good = runs.filter((r) => r.status === 'success' && Array.isArray(r.activity?.tools)).slice(0, MAX_RUNS);
    const byTool = new Map<string, { app: string | null; inRuns: number; calls: number }>();
    for (const run of good) {
        for (const use of run.activity?.tools ?? []) {
            if (typeof use.name !== 'string' || !use.name) continue;
            const calls = typeof use.ok === 'number' ? use.ok : 0;
            if (calls === 0) continue;
            const known = byTool.get(use.name) ?? { app: typeof use.app === 'string' ? use.app : null, inRuns: 0, calls: 0 };
            known.inRuns += 1;
            known.calls += calls;
            byTool.set(use.name, known);
        }
    }
    const habits = [...byTool.entries()]
        .map(([tool, h]): ToolHabit => ({ tool, app: h.app, inRuns: h.inRuns, callsPerRun: Math.max(1, Math.round(h.calls / h.inRuns)) }))
        .sort((a, b) => b.inRuns - a.inRuns || b.callsPerRun - a.callsPerRun || a.tool.localeCompare(b.tool));
    const steady = habits.filter((h) => h.inRuns === good.length);
    return {
        runs: good.length, habits, steady,
        readsOutsideText: good.some((r) => r.activity?.readOutsideText === true),
        worthIt: good.length >= MIN_RUNS && steady.length > 0,
    };
}

/** What the planner is told about those runs. */
export function hintsOf(signals: RoutineSignals): string {
    const used = signals.steady.map((h) => `${h.tool} (about ${h.callsPerRun} call${h.callsPerRun === 1 ? '' : 's'} a run)`).join(', ');
    return [
        `This item ran ${signals.runs} times with an AI deciding every step. Every one of those runs used: ${used}.`,
        'Make those FIXED steps where the work is the same every run, with the same inputs the brief implies; keep an ai_step only where the work needs judgement or writing.',
        signals.readsOutsideText ? 'Those runs read text from outside (web pages or mail): an ai_step that reads it gets no tools.' : '',
    ].filter(Boolean).join('\n');
}
