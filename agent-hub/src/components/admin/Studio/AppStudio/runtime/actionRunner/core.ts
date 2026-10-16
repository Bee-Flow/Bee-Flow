/**
 * The shared vocabulary of the App Studio action runner: its sentinels,
 * deadlines, the step-kind partition and the small pure helpers every phase
 * (effects, the v1 automation bridge, the sequence coordinator) uses. The
 * hook that wires them together is ../useActionRunner.ts.
 */
import type { TranslateParams } from '../../../../../../hooks/useTranslation';
import toast from '../../../../../shared/Toast';
import type { RunStep } from './stepWalk';

export {
    MAX_LOOP_ITERATIONS, SERVER_STEP_KINDS, buildStepIndexMap, caseMatches, normalizeSequence, resolveNavParams,
    sequenceHasServerStep,
} from './stepWalk';
export type { RunStep } from './stepWalk';

/** The runner's translate function: key, English fallback, placeholders. */
export type Translate = (key: string, fallback?: string, params?: TranslateParams) => string;

export type ActionStatus = 'idle' | 'running' | 'success' | 'error';

export interface ActionEntry {
    status: ActionStatus;
    result: unknown;
    error: string | null;
}

export type ActionState = Record<string, ActionEntry>;
export type Vars = Record<string, unknown>;

/** What a trigger hands runAction: the form it sits in and the row/value beside it. */
export interface RunOpts {
    formValues?: Record<string, unknown>;
    formId?: string;
    formName?: string;
    item?: unknown;
    index?: number;
    value?: unknown;
}

/** A navigate effect: the authored string, or the { screenId, params } a return_to_app step sends. */
export type NavigateTarget = string | { screenId?: string; params?: Record<string, unknown> | null } | null;

/** "What happens when the action is done" — authored onSuccess/onError or an automation's _appEffects. */
export interface EffectObject {
    toast?: { message?: string; tone?: string } | null;
    navigateTo?: NavigateTarget;
    refresh?: unknown;
    onError?: unknown;
    [key: string]: unknown;
}

/** An action from definition.actions: a bare v1 action or a v2 { kind:'sequence', steps }. */
export interface RunnableAction extends RunStep {
    onSuccess?: EffectObject;
    onError?: EffectObject;
}

export const POLL_INTERVAL_MS = 2000;
export const POLL_TIMEOUT_MS = 90000;

// Sentinel thrown when polling is abandoned because the hook is no longer alive
// (unmount / leaving run mode). It lets a catch tell a cancellation apart from a
// real failure so it can skip BOTH the error state and the onError effects.
export const CANCELLED = Symbol('useActionRunner.cancelled');
// Sentinel that unwinds a sequence cleanly (a declined confirm, or an onError
// branch that already handled the failure) — no error state, no toast.
export const SEQ_ABORT = Symbol('useActionRunner.abort');

// A hard deadline on one server step. Deliberately longer than the server's own
// AI ceiling (STUDIO_APP_AI_TIMEOUT_MS, 120s) so a real server error still wins
// the race and the user gets the specific message rather than this generic one.
export const STEP_DEADLINE_MS = 135_000;

// A browse holds a browser slot far longer than a data step. Deadline sits
// ABOVE the server's own 240s hard cap (routes/studioAppBrowse.js) so a
// specific server error still wins the race over this generic backstop.
export const BROWSE_STEP_DEADLINE_MS = 250_000;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The effect object to apply after a run: what the AUTOMATION returned
 * (`_appEffects` from a return_to_app step) laid over what the app AUTHOR
 * wrote on the action. Per key, so an author's toast survives an automation that
 * only asked for a navigation.
 */
export function mergeAppEffects(authored: unknown, fromRun: unknown): EffectObject | undefined {
    if (!fromRun || typeof fromRun !== 'object' || Array.isArray(fromRun)) return authored as EffectObject | undefined;
    return { ...(authored && typeof authored === 'object' ? authored : {}), ...fromRun };
}

export function showToast(tone: unknown, message: unknown): void {
    if (!message) return;
    const text = message as string;
    if (tone === 'success') toast.success(text);
    else if (tone === 'danger') toast.error(text);
    else toast.info(text); // 'info' and 'warning' share the info style
}

// Distinct copy for a server step rejected by the storage quota (the server
// marks it with code:'quota_exceeded' — 409 body or step-result body alike).
export const quotaToast = (tr: Translate): string => tr('studio_apps_runtime.actions.quota_reached', 'Storage limit reached — delete rows or attachments to continue');

export function defaultConfirm(step: RunStep | null | undefined, tr: Translate): Promise<boolean> {
    const message = (step && step.message) || tr('studio_apps_runtime.actions.are_you_sure', 'Are you sure?');
    if (typeof window === 'undefined') return Promise.resolve(true);
    // window.confirm is the default only when no host mounts a dialog: the
    // runtime bundle (published apps) has no shared useConfirm to fall back on.
    // eslint-disable-next-line no-restricted-properties -- the runtime's last resort, see above
    try { return Promise.resolve(window.confirm(message)); } catch { return Promise.resolve(true); }
}

/** An error's message, or the generic "The action failed." */
export function failureMessage(err: unknown, tr: Translate): string {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    return (typeof message === 'string' && message) || tr('studio_apps_runtime.actions.failed', 'The action failed.');
}

/** Reads a fetch body as JSON, or null when it is not JSON. */
export async function readJson(res: Response): Promise<Record<string, unknown> | null> {
    try { return await res.json(); } catch { return null; }
}
