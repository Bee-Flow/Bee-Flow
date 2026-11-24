/**
 * What a Cowork task's owner chose on its confirmation, and where setting it up stands, as two columns of the item
 * (stores/ddl/cowork-plans-2026-11.js; the rules are core/cowork/taskSetup.mts, the use case usecases/coworkSetup.mts):
 *
 *   setup_state  'wanted'  the task is to get fixed steps: Cowork sets them up and tests them, its owner approves them;
 *                'failed'  setting them up did not work, or its owner left before it finished;
 *                'ai'      its owner let the AI work it out every run;
 *                NULL      nobody set it up this way (a task from the chat, an older one): it runs as it always did.
 *   setup_json   who it sends to and whether its owner sees each message first, why the set-up failed (a class, never
 *                an error text), when it last started, and what "let the AI work it out every run" took off, for Undo.
 *
 * The recipients are the owner's own choice and stay with the task: they are written here and nowhere else, never
 * logged, and they go when the task goes.
 *
 * This file is the shape and how a row is read (stores/coworkRows.js reads it for every item); the reads and writes
 * of the two columns are ./coworkSetupStore.mts.
 */

export type SetupState = 'wanted' | 'failed' | 'ai';

/**
 * SQL for a one-off item that waits for its owner (its steps are not set up or not approved, core/cowork/taskSetup.mts
 * heldForSetup): the due query leaves it out, or it would stay due on every tick (stores/coworkStore.js
 * getDueSchedules). A repeating one is read, and the runner moves its moment on without running it
 * (core/cowork/coworkRunner.js).
 */
export const HELD_ONE_OFF = `COALESCE(setup_state, '') IN ('wanted', 'failed') AND plan_id IS NULL AND repeat_interval IS NULL AND days_of_week IS NULL`;
export const SETUP_CAUSES = ['no_model', 'not_available', 'timeout', 'unclear', 'budget', 'left', 'failed'] as const;
/** Why a set-up ended without steps, as a class. */
export type SetupCause = typeof SETUP_CAUSES[number];

/** Who a task sends to: its owner, and the addresses its owner named. */
export interface SendsTo { me: boolean; others: string[] }

/** What "let the AI work it out every run" took off the task. */
export interface SetupWas { state: SetupState | null; cause: SetupCause | null; planAutomationId: string | null; planId: string | null }

/** What `setup_json` holds. */
export interface SetupRecord {
    sendsTo?: SendsTo;
    askFirst?: boolean;
    cause?: SetupCause | null;
    /** When the set-up last started (ISO). */
    since?: string | null;
    was?: SetupWas | null;
}

/** The set-up as the task's owner reads it (GET /api/cowork). */
export interface TaskSetup {
    steps: SetupState | null;
    cause: SetupCause | null;
    since: string | null;
    sendsTo: SendsTo | null;
    askFirst: boolean | null;
    /** "Let the AI work it out every run" can be undone: what it took off is still known. */
    canUndo: boolean;
}

export const isSetupState = (v: unknown): v is SetupState => v === 'wanted' || v === 'failed' || v === 'ai';
const isCause = (v: unknown): v is SetupCause => typeof v === 'string' && (SETUP_CAUSES as readonly string[]).includes(v);

function sendsToOf(v: unknown): SendsTo | null {
    if (!v || typeof v !== 'object') return null;
    const { me, others } = v as { me?: unknown; others?: unknown };
    return { me: me !== false, others: Array.isArray(others) ? others.filter((o): o is string => typeof o === 'string' && !!o) : [] };
}

/** `setup_json` as a record; an unreadable one is an empty record. */
export function recordOf(json: unknown): SetupRecord {
    if (typeof json !== 'string' || !json) return {};
    try {
        const v = JSON.parse(json) as unknown;
        return v && typeof v === 'object' && !Array.isArray(v) ? v as SetupRecord : {};
    } catch { return {}; }
}

/** The two columns as the owner reads them; null for a task nobody set up this way. */
export function setupViewOf(state: unknown, json: unknown): TaskSetup | null {
    if (!isSetupState(state) && (typeof json !== 'string' || !json)) return null;
    const record = recordOf(json);
    const steps = isSetupState(state) ? state : null;
    return {
        steps,
        cause: steps === 'failed' && isCause(record.cause) ? record.cause : null,
        since: typeof record.since === 'string' ? record.since : null,
        sendsTo: sendsToOf(record.sendsTo),
        askFirst: typeof record.askFirst === 'boolean' ? record.askFirst : null,
        canUndo: steps === 'ai' && !!record.was,
    };
}
