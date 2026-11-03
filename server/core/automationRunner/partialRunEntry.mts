/**
 * How a root partial run (▶ Execute, retry-from, "Run up to here") enters the
 * flow: through which trigger, and with which trigger payload. Split out of
 * partialRuns.js. Pure.
 *
 * The payload (RM-8, replayedTriggerPayload):
 * The caller's own payload wins; a chosen run (seedRunId) gives its own; a
 * pinned sample on the entered trigger is left to executeAutomation
 * (resolveTriggerPayload: pins win over history). Otherwise it is the payload of
 * the newest run in the window that seeded the replay, the rule the loop-body
 * path follows, so the replayed upstream outputs and `trigger.output.*` describe
 * the same real input instead of real step outputs next to an empty trigger.
 * `source` names that run; the response reports it as `replaySource`.
 */

export type WindowRun = { id?: string; version?: number | null; startedAt?: string | null; triggerPayload?: unknown };
export type ReplaySource = { runId: string | null; version: number | null; startedAt: string | null; triggerPayload: true };
type TriggerNode = { id?: string; pinnedOutput?: unknown };
type TriggerDefinition = { trigger?: TriggerNode | null; triggers?: unknown; edges?: unknown };
type Edge = { from?: string; to?: string };

const triggersOf = (def: TriggerDefinition): TriggerNode[] =>
    (Array.isArray(def.triggers) ? def.triggers as TriggerNode[] : []);

/**
 * Which trigger node reaches `stepId` through the root edges: the primary
 * (returned as null, the runner's "enter at the primary") when it does, else
 * the first ADDITIONAL trigger that does. A step only wired from a secondary
 * trigger would be seeded from the primary, whose walk never reaches it, so
 * "Run up to here" on it would execute nothing.
 */
export function rootReaching(def: TriggerDefinition, stepId: string): string | null {
    const edges = (Array.isArray(def.edges) ? def.edges : []) as Array<Edge | null>;
    const reaches = (fromId: string): boolean => {
        const seen = new Set<string | undefined>([fromId]);
        const queue: Array<string | undefined> = [fromId];
        while (queue.length) {
            const cur = queue.shift();
            if (cur === stepId) return true;
            for (const e of edges) {
                if (e && e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
            }
        }
        return false;
    };
    if (!def.trigger?.id || reaches(def.trigger.id)) return null;
    const extra = triggersOf(def).find((t) => !!t?.id && reaches(t.id));
    return extra?.id ?? null;
}

export function replayedTriggerPayload({ triggerPayload, seedRunId, runsWindow, enteredTrigger }: {
    triggerPayload: unknown;
    seedRunId: string | null;
    runsWindow?: WindowRun[] | null;
    enteredTrigger?: TriggerNode | null;
}): { payload: unknown; source: ReplaySource | null } {
    if (triggerPayload !== undefined && triggerPayload !== null) return { payload: triggerPayload, source: null };
    if (seedRunId) return { payload: runsWindow?.[0]?.triggerPayload ?? null, source: null };
    const pin = enteredTrigger?.pinnedOutput;
    if (pin !== undefined && pin !== null) return { payload: null, source: null };
    const from = (runsWindow || []).find((r) => r?.triggerPayload !== undefined && r?.triggerPayload !== null);
    if (!from) return { payload: null, source: null };
    return {
        payload: from.triggerPayload,
        source: { runId: from.id || null, version: from.version ?? null, startedAt: from.startedAt || null, triggerPayload: true },
    };
}

/** The trigger node (the primary or an additional one) a run enters through; null = the primary. */
export function enteredTriggerOf(def: TriggerDefinition, rootStepId: string | null): TriggerNode | null {
    if (!rootStepId) return def.trigger || null;
    return [def.trigger, ...triggersOf(def)].find((t) => !!t && t.id === rootStepId) || null;
}
