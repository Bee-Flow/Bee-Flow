/**
 * isSideEffect for ONE call, with its resolved arguments: the question the
 * runner asks before it decides whether a dry run may dispatch for real.
 *
 * ./sideEffectMap.js answers per tool NAME, and every name-level reader (the
 * catalog badge, effectOf, the first-run confirmation) keeps that answer. A
 * few tools have an effect that follows an ARGUMENT instead: the generic
 * `nextcloud_request` reads with GET, PROPFIND and REPORT and writes with
 * everything else. Its name stays in SIDE_EFFECTS (fail-closed); here a call
 * whose `method` (any case) is one of its read methods is a read. Any other
 * method, a missing one included, is a side effect.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { isSideEffect } = nodeRequire('./sideEffectMap.js') as { isSideEffect: (toolName: unknown) => boolean };

/** Per tool: the methods that make a call to it a read. */
export const METHOD_DEPENDENT_READS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    nextcloud_request: new Set(['GET', 'PROPFIND', 'REPORT']),
});

export function isSideEffectCall(toolName: unknown, args: Record<string, unknown> | null | undefined): boolean {
    if (typeof toolName === 'string' && Object.hasOwn(METHOD_DEPENDENT_READS, toolName)) {
        const method = args && typeof args.method === 'string' ? args.method.trim().toUpperCase() : '';
        return !METHOD_DEPENDENT_READS[toolName].has(method);
    }
    return isSideEffect(toolName);
}
