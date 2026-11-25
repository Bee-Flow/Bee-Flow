/**
 * What a run-step row keeps of a step's input (`automation_run_steps.input_json`), as one function: the record path
 * (./runsSteps.js recordRunStep) writes it, and a replay that looks a recorded read up by its input
 * (core/automationRunner/recordedReads.mts) computes the same form of the input it is about to read with. One
 * definition, so the two can never drift apart: secrets and sensitive keys masked first, then the 256 KB cap, then
 * the NUL characters a jsonb column cannot hold.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { redactForPersistence, safeOutputKeysForTool } = nodeRequire('./runLogRedaction') as {
    redactForPersistence: (value: unknown, opts: { secretValues?: unknown[]; allowKeys?: string[]; publicValues?: unknown[] }) => { value: unknown };
    safeOutputKeysForTool: (toolName: string | null) => string[];
};
const { truncatePayload } = nodeRequire('./payloadTruncation') as { truncatePayload: (value: unknown) => { value: unknown } };

const NUL = String.fromCharCode(0);

/**
 * The value with every NUL character taken out of its strings, walked on the RAW value: Postgres refuses NUL in a
 * jsonb or text column and aborts the whole run record. Not a regex over the JSON text: that text escapes a literal
 * backslash before 'u0000' to two backslashes, and stripping one of them left a dangling escape the insert refused.
 */
export function stripNulDeep(v: unknown): unknown {
    if (typeof v === 'string') return v.indexOf(NUL) === -1 ? v : v.split(NUL).join('');
    if (Array.isArray(v)) return v.map(stripNulDeep);
    if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v)) out[k] = stripNulDeep((v as Record<string, unknown>)[k]);
        return out;
    }
    return v;
}

export interface PersistOptions {
    /** Values that must never be stored (the run's secrets and injected credentials). */
    secretValues?: unknown[];
    /** Values known to be public identifiers (a Talk room token). */
    publicValues?: unknown[];
    /** The step's tool: some tools' sensitive-looking keys are public identifiers. */
    toolName?: string | null;
}

/** The masking pass of the record path, for one step. */
export function redactorFor({ secretValues = [], publicValues = [], toolName = null }: PersistOptions): (v: unknown) => unknown {
    const allowKeys = safeOutputKeysForTool(toolName);
    return (v) => redactForPersistence(v, { secretValues, allowKeys, publicValues }).value;
}

/** The input as a run-step row stores it (before JSON.stringify), or null for a step without input. */
export function persistedInputOf(input: unknown, opts: PersistOptions = {}): unknown {
    if (input == null) return null;
    return stripNulDeep(truncatePayload(redactorFor(opts)(input)).value);
}
