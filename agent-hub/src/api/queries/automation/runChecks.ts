// Run compare, golden runs and form scenarios: the ONLY place that knows the
// wire contract of
//   GET    /api/automation/runs/:runId/compare/:otherRunId
//   POST|DELETE /api/automation/runs/:runId/golden, GET /:id/goldens, POST /:id/goldens/replay
//   /api/automation/:id/form-scenarios[/:scenarioId[/dry-run]]
// (server/routes/automation/runCompare.js, goldens.js, formScenarios.js).
//
// The shapes are in runChecksTypes.ts and the defensive readers in
// runChecksParse.ts; both are re-exported here, so a screen imports one module.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { API_BASE, authFetch } from '@/utils/helpers';
import { failure } from './http';
import { runsKeys } from './runs';
import {
    parseCompare, parseGolden, parseGoldenList, parseScenario, parseScenarioDetail, parseScenarioList,
} from './runChecksParse';
import type {
    AiAnswers, CompareResult, GoldenItem, GoldenList, ScenarioDetail, ScenarioDryRun, ScenarioItem, ScenarioList,
} from './runChecksTypes';

export * from './runChecksTypes';
export * from './runChecksParse';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ── Wire ───────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

interface Init { method?: string; headers?: Record<string, string>; body?: string }

async function request(path: string, what: string, init?: Init, signal?: AbortSignal): Promise<unknown> {
    const res = await authFetch(`${API_BASE}/api/automation${path}`, { ...init, signal });
    if (!res.ok) throw await failure(res, `${what} ${res.status}`);
    return res.json().catch(() => null);
}

const sendJson = (method: string, body: unknown): Init => ({
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const runCheckKeys = {
    all: ['automation-run-checks'] as const,
    compare: (a: string, b: string, stepId: string | null) => ['automation-run-checks', 'compare', a, b, stepId] as const,
    goldens: (automationId: string) => ['automation-run-checks', 'goldens', automationId] as const,
    scenarios: (automationId: string | null | undefined) => ['automation-run-checks', 'scenarios', automationId] as const,
    scenario: (automationId: string, id: string) => ['automation-run-checks', 'scenario', automationId, id] as const,
};

// ── Compare ────────────────────────────────────────────────────────────────

/** Run `runId` (A) against `otherRunId` (B), optionally for one step. */
export function useRunCompare(runId: string | null, otherRunId: string | null, stepId: string | null = null) {
    return useQuery<CompareResult, Error>({
        queryKey: runCheckKeys.compare(runId || '', otherRunId || '', stepId),
        queryFn: async ({ signal }) => {
            const q = stepId ? `?stepId=${enc(stepId)}` : '';
            return parseCompare(await request(`/runs/${enc(runId as string)}/compare/${enc(otherRunId as string)}${q}`, 'Compare', undefined, signal));
        },
        enabled: !!runId && !!otherRunId,
        // A refusal (different automations, hidden data) will not change on a retry.
        retry: false,
        staleTime: 30_000,
    });
}

// ── Goldens ────────────────────────────────────────────────────────────────

const GOLDEN_POLL_MS = 3000;

/** While any replay is running the list is read again every few seconds; else never. Exported for the test. */
export function goldenPollMs(data: GoldenList | undefined): number | false {
    return data?.goldens.some(g => g.lastReplay?.status === 'running') ? GOLDEN_POLL_MS : false;
}

export function useGoldens(automationId: string | null, enabled = true) {
    return useQuery<GoldenList, Error>({
        queryKey: runCheckKeys.goldens(automationId || ''),
        queryFn: async ({ signal }) => parseGoldenList(await request(`/${enc(automationId as string)}/goldens`, 'Golden runs', undefined, signal)),
        enabled: enabled && !!automationId,
        retry: false,
        staleTime: 10_000,
        refetchInterval: (query: Query<GoldenList, Error>) => goldenPollMs(query.state.data),
    });
}

export interface MarkGoldenInput { runId: string; label?: string; ignorePaths?: string[] }

export function useMarkGolden(automationId: string | null) {
    const qc = useQueryClient();
    return useMutation<GoldenItem | null, Error, MarkGoldenInput>({
        mutationFn: async ({ runId, label, ignorePaths }) => {
            const body: Record<string, unknown> = {};
            if (label) body.label = label;
            if (ignorePaths?.length) body.ignorePaths = ignorePaths;
            const out = await request(`/runs/${enc(runId)}/golden`, 'Mark as golden', sendJson('POST', body));
            return parseGolden(isRecord(out) ? out.golden : null);
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: runCheckKeys.goldens(automationId || '') }); },
    });
}

export function useUnmarkGolden(automationId: string | null) {
    const qc = useQueryClient();
    return useMutation<boolean, Error, string>({
        mutationFn: async (runId) => {
            const out = await request(`/runs/${enc(runId)}/golden`, 'Remove golden', { method: 'DELETE' });
            return isRecord(out) && out.deleted === true;
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: runCheckKeys.goldens(automationId || '') }); },
    });
}

export interface ReplayInput { goldenIds?: string[]; aiAnswers: AiAnswers }

/** Start a replay; the answer is 202, and the verdicts land on the list (which then polls). */
export function useReplayGoldens(automationId: string) {
    const qc = useQueryClient();
    return useMutation<string[], Error, ReplayInput>({
        mutationFn: async ({ goldenIds, aiAnswers }) => {
            const body: Record<string, unknown> = { aiAnswers };
            if (goldenIds?.length) body.goldenIds = goldenIds;
            const out = await request(`/${enc(automationId)}/goldens/replay`, 'Replay', sendJson('POST', body));
            return isRecord(out) ? list(out.replaying).filter((i): i is string => typeof i === 'string') : [];
        },
        onSettled: () => { qc.invalidateQueries({ queryKey: runCheckKeys.goldens(automationId) }); },
    });
}

// ── Form scenarios ─────────────────────────────────────────────────────────

export function useFormScenarios(automationId: string | null | undefined, enabled = true) {
    return useQuery<ScenarioList, Error>({
        queryKey: runCheckKeys.scenarios(automationId || ''),
        queryFn: async ({ signal }) => parseScenarioList(await request(`/${enc(automationId as string)}/form-scenarios`, 'Scenarios', undefined, signal)),
        enabled: enabled && !!automationId,
        retry: false,
        staleTime: 10_000,
    });
}

/** One scenario WITH its answers; fetched only when `scenarioId` is set. */
export function useFormScenario(automationId: string | null | undefined, scenarioId: string | null) {
    return useQuery<ScenarioDetail | null, Error>({
        queryKey: runCheckKeys.scenario(automationId || '', scenarioId || ''),
        queryFn: async ({ signal }) => {
            const out = await request(`/${enc(automationId as string)}/form-scenarios/${enc(scenarioId as string)}`, 'Scenario', undefined, signal);
            return parseScenarioDetail(isRecord(out) ? out.scenario : null);
        },
        enabled: !!automationId && !!scenarioId,
        retry: false,
        staleTime: 30_000,
    });
}

export function useCreateFormScenario(automationId: string | null | undefined) {
    const qc = useQueryClient();
    return useMutation<ScenarioItem | null, Error, { name: string; fromRunId: string }>({
        mutationFn: async ({ name, fromRunId }) => {
            const out = await request(`/${enc(String(automationId))}/form-scenarios`, 'Save scenario', sendJson('POST', { name, fromRunId }));
            return parseScenario(isRecord(out) ? out.scenario : null);
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: runCheckKeys.scenarios(automationId) }); },
    });
}

export function useRenameFormScenario(automationId: string) {
    const qc = useQueryClient();
    return useMutation<ScenarioItem | null, Error, { scenarioId: string; name: string }>({
        mutationFn: async ({ scenarioId, name }) => {
            const out = await request(`/${enc(automationId)}/form-scenarios/${enc(scenarioId)}`, 'Rename scenario', sendJson('PUT', { name }));
            return parseScenario(isRecord(out) ? out.scenario : null);
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: runCheckKeys.scenarios(automationId) }); },
    });
}

export function useDeleteFormScenario(automationId: string) {
    const qc = useQueryClient();
    return useMutation<boolean, Error, string>({
        mutationFn: async (scenarioId) => {
            const out = await request(`/${enc(automationId)}/form-scenarios/${enc(scenarioId)}`, 'Delete scenario', { method: 'DELETE' });
            return isRecord(out) && out.deleted === true;
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: runCheckKeys.scenarios(automationId) }); },
    });
}

/** Dry run with a scenario's answers: nothing is sent. Resolves to the new run's id. */
export function useDryRunFormScenario(automationId: string) {
    const qc = useQueryClient();
    return useMutation<ScenarioDryRun, Error, { scenarioId: string; triggerStepId?: string }>({
        mutationFn: async ({ scenarioId, triggerStepId }) => {
            const body = triggerStepId ? { triggerStepId } : {};
            const out = await request(`/${enc(automationId)}/form-scenarios/${enc(scenarioId)}/dry-run`, 'Dry run', sendJson('POST', body));
            const run = isRecord(out) && isRecord(out.run) ? out.run : null;
            return { runId: str(run?.id), status: str(run?.status) };
        },
        onSettled: () => { qc.invalidateQueries({ queryKey: runsKeys.all }); },
    });
}
