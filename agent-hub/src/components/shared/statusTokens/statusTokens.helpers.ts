import { type SkipGroup, type RunStepLike } from './statusTokens.types';
import { SKIP_REASONS } from './statusTokens.constants';

/**
 * Read a table entry only when the table itself declares it.
 *
 * `'constructor' in ALIASES` and `TABLE['__proto__']` are both TRUE of every
 * object literal, so a plain lookup answers a question about Object.prototype
 * rather than about statuses: `tokenFor('constructor')` used to return
 * undefined (the alias branch was taken, and there is no such alias), and the
 * first call site to read `.solid` off it threw — from a function whose whole
 * contract is that it never does. Not reachable from today's server enum;
 * reachable the moment a status word comes from a URL, a saved filter or a
 * pasted definition.
 */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Which group a recorded skip belongs to, or null when the row cannot say.
 *
 * `skippedReason` is the answer whenever it is there, and one day it always
 * will be: the runner sets it on every skip, but `recordRunStep`
 * (server/stores/automationStore/runs.js) has no parameter for it and
 * `automation_run_steps` has no column, so today it never reaches a client.
 *
 * Until it does, the row's SHAPE carries the same fact without anyone having
 * to read a sentence:
 *   - `output.disabled === true` is what execution.js emits for a switched-off
 *     step, and only for that;
 *   - `output.skipped` is a string on every one of the fifteen `no_work` codes
 *     and on none of the others (each exec module builds it through its own
 *     `skipped()` helper, which puts the code top-level and the sentence
 *     there). Its PRESENCE is the signal; its text is never inspected.
 * Anything else is unknown, and an unknown skip stays grey.
 */
export function skipGroupOfStep(step: RunStepLike | null | undefined): SkipGroup | null {
    const reason = step?.skippedReason;
    const known = reason ? own(SKIP_REASONS, String(reason).toLowerCase()) : undefined;
    if (known) return known;
    const output = step?.output;
    if (output && typeof output === 'object') {
        const shape = output as { disabled?: unknown; skipped?: unknown };
        if (shape.disabled === true) return 'configured';
        if (typeof shape.skipped === 'string' && shape.skipped.trim()) return 'no_work';
    }
    return null;
}
