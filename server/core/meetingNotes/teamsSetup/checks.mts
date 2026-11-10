/**
 * The shapes of a Teams diagnostics report and the rules every check follows.
 *
 * A check has a catalogue id (`a.connection`), a status, a stable snake_case
 * code the client turns into a sentence (`teams_setup.code.<code>`), a few
 * allow-listed params for that sentence, the remediation key and who can fix
 * it. Nothing else travels: `sanitizeParams` drops every key it does not know,
 * so a probe that hands it a Graph body by mistake still sends none of it.
 *
 * Prerequisites (decision 15): a check runs only when every prerequisite
 * passed; otherwise it is `skipped` with `prerequisite_failed` and the first
 * prerequisite that did not pass.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped' | 'unknown';
export type Fixer = 'user' | 'org_admin' | 'entra_admin' | 'teams_admin' | 'platform_admin';
export type CheckParams = Record<string, string | number | boolean | string[]>;
export type CheckOption = 'A' | 'B' | 'app';
export type ReportLevel = 'platform' | 'user' | 'org' | 'org_app';

export interface TeamsCheck {
    id: string;
    option: CheckOption;
    status: CheckStatus;
    code: string;
    params: CheckParams;
    remediation: string | null;
    fixer: Fixer | null;
    dependsOn: string[];
}

export interface TeamsDiagnosticsReport {
    level: ReportLevel;
    ranAt: string;
    overall: 'pass' | 'warn' | 'fail';
    checks: TeamsCheck[];
}

/** What a probe decided, before the catalogue adds id, option and prerequisites. */
export interface Outcome {
    status: CheckStatus;
    code: string;
    params?: Record<string, unknown>;
    /** The remediation name (`new_client_secret`), or a full key; null = none. */
    fix?: string | null;
    fixer?: Fixer | null;
}

export const PARAM_ALLOW_LIST: readonly string[] = Object.freeze([
    'permission', 'permissions', 'missing', 'roles', 'aadsts', 'error', 'httpStatus',
    'count', 'endedOrganised', 'upcoming', 'probe', 'allowRecording', 'allowTranscription', 'recordAutomatically',
    'tenantMode', 'tenantSource', 'tenantId', 'source', 'uris', 'at', 'reason', 'autoRecordConfig', 'covered',
    'withoutIdentity', 'otherTenant', 'withoutAccess', 'notSelected', 'self', 'clientId', 'prerequisite', 'coverage',
    'capability',
]);

/** Params only an administrator's report may carry. */
const ADMIN_ONLY_PARAMS = new Set(['tenantId', 'clientId']);
const ADMIN_LEVELS = new Set<ReportLevel>(['platform', 'org', 'org_app']);
const ALLOWED = new Set(PARAM_ALLOW_LIST);
const MAX_STRING = 512;
const MAX_ITEMS = 50;

function cleanValue(value: unknown): string | number | boolean | string[] | undefined {
    if (typeof value === 'string') return value.slice(0, MAX_STRING);
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.filter((v): v is string => typeof v === 'string').slice(0, MAX_ITEMS).map((v) => v.slice(0, MAX_STRING));
    }
    return undefined;
}

/**
 * Only allow-listed keys, strings capped at 512 characters, arrays of strings
 * capped at 50 items; `tenantId` and `clientId` only in an admin report.
 */
export function sanitizeParams(params: Record<string, unknown> | null | undefined, level: ReportLevel): CheckParams {
    const out: CheckParams = {};
    if (!params || typeof params !== 'object') return out;
    for (const [key, value] of Object.entries(params)) {
        if (!ALLOWED.has(key)) continue;
        if (ADMIN_ONLY_PARAMS.has(key) && !ADMIN_LEVELS.has(level)) continue;
        const clean = cleanValue(value);
        if (clean !== undefined) out[key] = clean;
    }
    return out;
}

/** The full i18n key of a remediation name; a full key passes unchanged. */
export function fixKey(name: string | null | undefined): string | null {
    if (!name) return null;
    return name.startsWith('teams_setup.fix.') ? name : `teams_setup.fix.${name}`;
}

/** A finished check from a probe's outcome. */
export function toCheck(spec: { id: string; option: CheckOption; dependsOn?: string[] }, outcome: Outcome, level: ReportLevel): TeamsCheck {
    return {
        id: spec.id,
        option: spec.option,
        status: outcome.status,
        code: outcome.code,
        params: sanitizeParams(outcome.params, level),
        remediation: fixKey(outcome.fix ?? null),
        fixer: outcome.fixer ?? null,
        dependsOn: [...(spec.dependsOn || [])],
    };
}

/** The skipped result of a check whose prerequisite did not pass. */
export function skippedCheck(spec: { id: string; option: CheckOption; dependsOn?: string[] }, prerequisite: string): TeamsCheck {
    return {
        id: spec.id,
        option: spec.option,
        status: 'skipped',
        code: 'prerequisite_failed',
        params: { prerequisite },
        remediation: null,
        fixer: null,
        dependsOn: [...(spec.dependsOn || [])],
    };
}

/**
 * The first prerequisite that did not pass, or null when all passed. A
 * prerequisite in `passLike` also counts as passed when its status is listed
 * there (the "unknown counts as pass" exceptions of option B).
 */
export function firstNonPass(done: Map<string, TeamsCheck>, prerequisites: string[], passLike: Record<string, CheckStatus[]> = {}): string | null {
    for (const id of prerequisites) {
        const status = done.get(id)?.status;
        if (status === 'pass') continue;
        if (status && (passLike[id] || []).includes(status)) continue;
        return id;
    }
    return null;
}

/** fail if any fail; else warn if any warn or unknown; else pass. skipped is ignored. */
export function overallOf(checks: TeamsCheck[]): 'pass' | 'warn' | 'fail' {
    if (checks.some((c) => c.status === 'fail')) return 'fail';
    if (checks.some((c) => c.status === 'warn' || c.status === 'unknown')) return 'warn';
    return 'pass';
}

export function buildReport(level: ReportLevel, checks: TeamsCheck[], now: Date = new Date()): TeamsDiagnosticsReport {
    return { level, ranAt: now.toISOString(), overall: overallOf(checks), checks };
}

/** The outcome of a probe that did not answer in time. */
export const PROBE_TIMEOUT: Outcome = Object.freeze({ status: 'unknown', code: 'probe_timeout', fix: 'try_again_later', fixer: 'user' });

export type Probed<T> = { ok: true; value: T } | { ok: false; timedOut: true } | { ok: false; timedOut: false; error: unknown };

/**
 * Run a probe against a timeout (0 = none). Never throws: the result says
 * whether it answered, timed out or failed. The timer never keeps the process up.
 */
export async function raceProbe<T>(run: () => Promise<T>, timeoutMs: number): Promise<Probed<T>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
        if (timeoutMs > 0) {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
            timer.unref?.();
        }
    });
    try {
        const work = Promise.resolve().then(run);
        const winner = await Promise.race([work.then((value) => ({ value })), timeout]);
        if (winner === 'timeout') {
            work.catch(() => undefined);
            return { ok: false, timedOut: true };
        }
        return { ok: true, value: winner.value };
    } catch (error) {
        return { ok: false, timedOut: false, error };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
