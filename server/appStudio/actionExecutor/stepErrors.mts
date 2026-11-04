/**
 * App Studio action executor — the REAL reason a step failed, as a client-safe
 * step result. Never "Step failed".
 *
 * The dispatcher (dispatch.js) catches whatever a step module threw and hands
 * it here. Each error becomes `{ ok:false, error, code, retryable }`:
 *   - `error`: a sentence a person can act on. Messages the code base already
 *     writes for people (access refusals, compile errors, the AI deadline, a
 *     table-layer refusal) pass through; database and provider failures get a
 *     FIXED sentence (never the driver's text: it can quote values and
 *     constraint names); anything unknown says what failed and gives a
 *     reference that is also in the server log.
 *   - `code`: what kind of failure it was (a handler reads it as error.code).
 *   - `retryable`: whether trying the same step again can help. A
 *     deterministic refusal (bad input, no access, a duplicate value) is not;
 *     a timeout, a busy database, a provider hiccup is. The walkers only
 *     retry when this is not false.
 *
 * The log line carries the kind, the reference, the code, the status and the
 * error's class name: never its message, never provider text (it may quote
 * the prompt or customer values).
 */

import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;

export type StepFailureResult = {
    ok: false;
    error: string;
    code: string;
    retryable: boolean;
    ref?: string;
    limit?: unknown;
    used?: unknown;
};

type Deps = {
    log?: { error: (msg: string, meta?: Obj) => void };
    ref?: () => string;
    isRowsLocked?: (e: unknown) => boolean;
};

const AI_KINDS = new Set(['ai_extract', 'ai_generate', 'kb_query', 'ai_browse']);

/** What the step does, for a sentence ("The AI step", "The create record step"). */
function nounOf(kind: string): string {
    if (AI_KINDS.has(kind)) return 'AI';
    return kind.replace(/_/g, ' ');
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE']);

/** Engine codes whose message the engine already writes for people (pgAppEngineHelpers.mapPgError). */
const ENGINE_SAFE_CODES: Record<string, boolean> = {
    unique_violation: false, required_value: false, relation_violation: false, invalid_value: false,
};

/** Raw database codes → a fixed sentence, a code and whether a retry can help. */
const DB_CODES: Record<string, [string, string, boolean]> = {
    '23505': ['A record with this value already exists.', 'unique_violation', false],
    '23502': ['A required value is missing.', 'required_value', false],
    '23503': ['This change points at a related record that does not exist.', 'relation_violation', false],
    '23514': ['A value is not allowed by the table\'s rules.', 'check_violation', false],
    '40001': ['The database was busy with another change. Try again.', 'db_busy', true],
    '40P01': ['The database was busy with another change. Try again.', 'db_busy', true],
    '55P03': ['The database was busy with another change. Try again.', 'db_busy', true],
    '57014': ['The database took too long to answer.', 'db_timeout', true],
    SQLITE_BUSY: ['The database was busy with another change. Try again.', 'db_busy', true],
    SQLITE_LOCKED: ['The database was busy with another change. Try again.', 'db_busy', true],
    SQLITE_CONSTRAINT_UNIQUE: ['A record with this value already exists.', 'unique_violation', false],
    SQLITE_CONSTRAINT_PRIMARYKEY: ['A record with this value already exists.', 'unique_violation', false],
    SQLITE_CONSTRAINT_NOTNULL: ['A required value is missing.', 'required_value', false],
    SQLITE_CONSTRAINT_FOREIGNKEY: ['This change points at a related record that does not exist.', 'relation_violation', false],
    SQLITE_CONSTRAINT_CHECK: ['A value is not allowed by the table\'s rules.', 'check_violation', false],
    SQLITE_MISMATCH: ['A value does not fit its column type.', 'invalid_value', false],
};

function defaultRef(): string {
    return randomBytes(4).toString('hex');
}

function defaultRowsLocked(e: unknown): boolean {
    try {
        const qc = nodeRequire('../queryCompiler') as { RowsLockedError?: new (...a: unknown[]) => Error };
        return !!qc.RowsLockedError && e instanceof qc.RowsLockedError;
    } catch {
        return false;
    }
}

function defaultLog(): { error: (msg: string, meta?: Obj) => void } {
    return nodeRequire('../../telemetry/log') as { error: (msg: string, meta?: Obj) => void };
}

const fail = (error: string, code: string, retryable: boolean, extra: Partial<StepFailureResult> = {}): StepFailureResult =>
    ({ ok: false, error, code, retryable, ...extra });

function messageOf(e: Obj): string {
    return typeof e.message === 'string' ? e.message : '';
}

/** The rows of the mapping that read the error's own status / code (everything a person can act on). */
function knownFailure(e: Obj, kind: string): StepFailureResult | null {
    const status = typeof e.status === 'number' ? e.status : null;
    const code = typeof e.code === 'string' ? e.code : '';
    const msg = messageOf(e);
    if (status === 409 && code === 'quota_exceeded') {
        return fail(msg || 'Storage quota exceeded', 'quota_exceeded', false, { limit: e.limit, used: e.used });
    }
    if (code === 'ai_timeout' && e.safe === true) return fail(msg, 'ai_timeout', true);
    if (status === 403) return fail(msg || 'You do not have access to do this.', 'forbidden', false);
    if (status === 400) return fail(msg || 'The step was given input it cannot use.', 'bad_input', false);
    if (status === 422) {
        if (code === 'ai_no_output') return fail(msg || 'The AI did not return a usable answer.', 'ai_no_output', true);
        if (e.name === 'CompileError') return fail(msg || 'The step names a field it cannot use.', 'invalid_field', false);
        if (code in ENGINE_SAFE_CODES && msg) return fail(msg, code, false);
        return fail(msg || `The ${nounOf(kind)} step could not use this input.`, 'unprocessable', false);
    }
    if (status === 409 && code in ENGINE_SAFE_CODES && msg) return fail(msg, code, false);
    // A refusal from the table layer (appStudio/readError.js): a safe message and a status (503
    // "could not establish it", 501 "not possible here yet").
    if (e.safe === true && status !== null) return fail(msg || 'The linked table could not be reached.', 'datatable_source', status >= 500 && status !== 501);
    return null;
}

/** Database and provider/network failures: fixed sentences, never the driver's or provider's text. */
function infraFailure(e: Obj, kind: string): StepFailureResult | null {
    const code = typeof e.code === 'string' ? e.code : '';
    if (code === 'statement_timeout' || e.name === 'StatementTimeoutError') return fail('The database took too long to answer.', 'db_timeout', true);
    if (code && Object.hasOwn(DB_CODES, code)) {
        const [error, c, retryable] = DB_CODES[code];
        return fail(error, c, retryable);
    }
    const ai = AI_KINDS.has(kind);
    const who = ai ? 'The AI provider' : 'The service this step calls';
    const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null;
    if (status === 429) return fail(`${who} is receiving too many requests. Try again in a moment.`, 'provider_rate_limit', true);
    if (status === 401 || (status === 403 && ai)) return fail(`${who} refused the credentials. An administrator needs to check the connection.`, 'provider_credentials', false);
    if (status !== null && status >= 500 && status < 600) return fail(`${who} had a temporary problem. Try again.`, 'provider_unavailable', true);
    if (NETWORK_CODES.has(code) || code.startsWith('UND_ERR')) return fail(`${who} could not be reached. Try again.`, 'provider_unreachable', true);
    return null;
}

/**
 * The client-safe step result for an error a step threw. Logs an unknown one
 * (fields only, never its message) under a reference the message names.
 */
export function describeStepError(e: unknown, step: { kind?: unknown } | null | undefined, deps: Deps = {}): StepFailureResult {
    const kind = step && typeof step.kind === 'string' ? step.kind : 'step';
    const err: Obj = e && typeof e === 'object' ? (e as Obj) : {};
    const isRowsLocked = deps.isRowsLocked ?? defaultRowsLocked;
    if (isRowsLocked(e)) return fail(messageOf(err) || 'These rows are managed by a release and cannot be changed here.', 'managed_part', false);
    const known = knownFailure(err, kind) ?? infraFailure(err, kind);
    if (known) return known;
    const ref = (deps.ref ?? defaultRef)();
    const log = deps.log ?? defaultLog();
    log.error('[ActionExecutor] step failed', {
        kind, ref,
        code: typeof err.code === 'string' ? err.code.slice(0, 40) : null,
        status: typeof err.status === 'number' ? err.status : null,
        name: typeof err.name === 'string' ? err.name.slice(0, 60) : typeof e,
    });
    return fail(`The ${nounOf(kind)} step could not finish because of an internal error (reference ${ref}).`, 'internal', true, { ref });
}
