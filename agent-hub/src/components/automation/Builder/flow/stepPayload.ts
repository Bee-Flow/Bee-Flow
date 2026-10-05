/**
 * What a step PASSES ON, as opposed to what it merely reports about itself.
 *
 * Some step types wrap their payload in an envelope next to diagnostics. A
 * Code step returns `{ result: <whatever the code returned>, logs: [...console
 * lines], httpCalls: N }` (server/core/automationRunner/execOutbound.js).
 * `result` is the data; `logs` and `httpCalls` say how the run went. Every
 * client heuristic that looks for "the step's list" (the item count on a
 * connection, the runs view, the auto-mapper picking a Loop's source) used to
 * see the lone array `logs` and treat it as the payload, so a Code step that
 * returned one record read "0 items".
 *
 * ONE table answers the question for all of them. Add a step type here and
 * every heuristic follows; do not special-case it in a fourth place.
 *
 * Pure and framework-free.
 */

interface PayloadShape {
    /** The envelope key that holds the step's real output. */
    payloadKey: string;
    /** Sibling keys that describe the run, never the data. */
    diagnostics: readonly string[];
}

const PAYLOAD_SHAPES: Readonly<Record<string, PayloadShape>> = {
    code: {
        payloadKey: 'result',
        // `wouldHaveCalled` and the `_dryRun*` flags only exist on a rehearsal.
        diagnostics: ['logs', 'httpCalls', 'wouldHaveCalled', '_dryRun', '_dryRunSyntheticInputs'],
    },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The envelope key that holds this step type's real output (`result` for code), or null. */
export function payloadKeyOf(stepType: string | null | undefined): string | null {
    const shape = stepType ? PAYLOAD_SHAPES[stepType] : undefined;
    return shape ? shape.payloadKey : null;
}

/** Is `key` a diagnostic of this step type's output envelope (not data)? */
export function isDiagnosticOutputKey(stepType: string | null | undefined, key: string): boolean {
    const shape = stepType ? PAYLOAD_SHAPES[stepType] : undefined;
    return !!shape && shape.diagnostics.includes(key);
}

/**
 * The part of a step's output that travels to the next step. Unknown step
 * types, and outputs that are not shaped like the envelope (a pinned or typed
 * payload), come back unchanged.
 */
export function stepPayload(stepType: string | null | undefined, output: unknown): unknown {
    const shape = stepType ? PAYLOAD_SHAPES[stepType] : undefined;
    if (!shape || !isPlainObject(output)) return output;
    const looksLikeEnvelope = shape.payloadKey in output
        || shape.diagnostics.some(k => k in output);
    // A code step that returned nothing has no `result` key at all (JSON
    // drops undefined): the payload is then empty, not the diagnostics.
    return looksLikeEnvelope ? output[shape.payloadKey] : output;
}
