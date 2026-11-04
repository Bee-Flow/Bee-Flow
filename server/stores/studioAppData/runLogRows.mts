/**
 * stores/studioAppData/runLogRows.mts: the shapes of the run log (studio_app_action_runs as the
 * log reads it, studio_app_action_run_steps) and the row mappers and SQL fragments its store
 * (./runLogStore.mts) shares. Pure.
 */

export type Row = Record<string, unknown>;

export type RunOrigin = 'click' | 'public' | 'mcp' | 'test' | 'background' | 'mailbox_hook';
export const RUN_ORIGINS: readonly RunOrigin[] = Object.freeze(['click', 'public', 'mcp', 'test', 'background', 'mailbox_hook']);
export const BROWSER_ORIGINS: readonly string[] = Object.freeze(['click', 'public']);

export type NewLoggedRun = {
    id: string; appId: string; ownerUserId: string; actionId: string; origin: RunOrigin;
    viewerUserId: string | null; visitorKey?: string | null; draft: boolean; definitionVersion: number | null;
    dryRun?: boolean; client?: string | null; clientRunKey?: string | null; tracked?: boolean;
};

export type AiUsage = {
    calls: number; promptTokens: number; completionTokens: number; model: string | null; tier: string | null;
    cost: number | null; currency: string | null;
};

export type StepRecord = {
    actionId: string | null; stepIndex: number | null; path: string; iteration: number | null; kind: string;
    status: string; error: string | null; errorCode: string | null; attempts: number | null; handled: boolean;
    mocked: boolean; startedAt: number; durationMs: number; ai: AiUsage | null;
};

export type StoredStep = Omit<StepRecord, 'startedAt'> & { seq: number; startedAt: string | null };

export type RunListRow = {
    id: string; actionId: string; origin: string; draft: boolean; dryRun: boolean; definitionVersion: number | null;
    viewerUserId: string | null; viewerName: string | null; visitorKey: string | null; tracked: boolean;
    status: string; endedBy: string | null; error: string | null; errorCode: string | null; errorStep: Row | null;
    startedAt: string | null; endedAt: string | null; durationMs: number | null; stepCount: number; failedSteps: number;
    handledErrors: number; truncated: boolean; aiCalls: number; promptTokens: number; completionTokens: number;
    costByCurrency: Record<string, number>;
};

export type ListFilter = {
    appId: string; actionId?: string | null; status?: string | null; origins?: string[] | null;
    actor?: { kind: 'user'; userId: string } | { kind: 'visitors' } | { kind: 'system' } | { kind: 'others'; userId: string } | null;
    since?: string | null; before?: { startedAt: string; id: string } | null; limit: number;
    idleMs: number; staleMs: number;
};

export const changed = (r: { rowCount?: number | null; affectedRows?: number }): number => r.rowCount ?? r.affectedRows ?? 0;
export const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
export const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const json = (v: unknown): unknown => {
    if (typeof v !== 'string') return v ?? null;
    try { return JSON.parse(v); } catch { return null; }
};
export const asObj = (v: unknown): Row | null => {
    const j = json(v);
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Row : null;
};
export const clampInt = (v: unknown, max = 2_000_000_000): number => {
    const n = Math.floor(Number(v) || 0);
    return Math.max(0, Math.min(max, n));
};

export const AGO = (param: string): string => `NOW() - make_interval(secs => ${param}::double precision / 1000)`;

/**
 * A browser run that never sent its end report reads as ended once it is idle: no step in
 * flight and no activity for idleMs, or no activity for staleMs at all (a step that never came
 * back). Its status then follows its steps. $idle / $stale are the parameter placeholders.
 */
export function effectiveStatusSql(idle: string, stale: string): string {
    return `CASE WHEN r.status = 'running' AND r.origin IN ('click', 'public')
                   AND ((NOT r.in_flight AND r.last_activity_at < ${AGO(idle)}) OR r.last_activity_at < ${AGO(stale)})
              THEN (CASE WHEN r.failed_steps > 0 THEN 'error' ELSE 'success' END)
              ELSE r.status END`;
}

export function costMap(v: unknown): Record<string, number> {
    const o = asObj(v) ?? {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(o)) if (/^[A-Z]{3}$/.test(k) && Number.isFinite(Number(n))) out[k] = Number(n);
    return out;
}

export function toListRow(row: Row, names: Map<string, string | null>): RunListRow {
    const viewer = text(row.viewer_user_id);
    return {
        id: String(row.id), actionId: String(row.action_id), origin: String(row.origin), draft: row.draft === true,
        dryRun: row.dry_run === true, definitionVersion: num(row.definition_version),
        viewerUserId: viewer, viewerName: viewer ? names.get(viewer) ?? null : null, visitorKey: text(row.visitor_key),
        tracked: row.tracked !== false, status: String(row.effective_status ?? row.status),
        endedBy: text(row.effective_ended_by ?? row.ended_by), error: text(row.error), errorCode: text(row.error_code),
        errorStep: asObj(row.error_step), startedAt: iso(row.started_at), endedAt: iso(row.ended_at),
        durationMs: num(row.effective_duration_ms ?? row.duration_ms), stepCount: Number(row.step_count ?? 0),
        failedSteps: Number(row.failed_steps ?? 0), handledErrors: Number(row.handled_errors ?? 0), truncated: row.truncated === true,
        aiCalls: Number(row.ai_calls ?? 0), promptTokens: Number(row.prompt_tokens ?? 0), completionTokens: Number(row.completion_tokens ?? 0),
        costByCurrency: costMap(row.cost_by_currency),
    };
}

export function toStoredStep(row: Row): StoredStep {
    const calls = Number(row.ai_calls ?? 0);
    return {
        seq: Number(row.seq), actionId: text(row.action_id), stepIndex: num(row.step_index), path: String(row.path),
        iteration: num(row.iteration), kind: String(row.kind), status: String(row.status), error: text(row.error),
        errorCode: text(row.error_code), attempts: num(row.attempts), handled: row.handled === true, mocked: row.mocked === true,
        startedAt: iso(row.started_at), durationMs: Number(row.duration_ms ?? 0),
        ai: calls > 0 || text(row.model) ? {
            calls, promptTokens: Number(row.prompt_tokens ?? 0), completionTokens: Number(row.completion_tokens ?? 0),
            model: text(row.model), tier: text(row.model_tier), cost: num(row.cost), currency: text(row.cost_currency),
        } : null,
    };
}

/** A display name for the run list: the display name, else a username that is not an address. */
export function displayName(row: Row): string | null {
    const dn = text(row.displayName);
    if (dn && dn.trim()) return dn.trim().slice(0, 120);
    const un = text(row.username);
    return un && !un.includes('@') ? un.slice(0, 120) : null;
}
