/**
 * The shape a step that "runs once per item" (`step.forEach`) hands
 * downstream, shared by its design-time group (groups.js wrapGroupForEach) and
 * its real-data overlay (realOverlay.js), so a field looks the same before and
 * after the first run.
 *
 * The runner wraps the per-iteration outputs as
 *   { iterations, succeeded, failed, results: [{ index, item, output, status }] }
 * (execForEachStep), and `results[*].output.<key>` collects one value per
 * iteration (the runtime's `[*]` flatten).
 */
import { appendKey, appendWildcard } from '@shared/expr/path.mjs';
import type { Field } from './fieldTree';

/** `<base>.results[*].output`: where one iteration's output sits. */
export function forEachOutputPath(base: string): string {
    return appendKey(appendWildcard(appendKey(base, 'results')), 'output');
}

/**
 * A top-level per-iteration field. A list stays a list (the iterations'
 * lists flatten into one). A single value becomes `[value]`, which is what
 * the path really yields (one per iteration), and is marked `perIteration` so
 * auto-map and the list-source guess leave it alone (BFSF-369).
 */
export function perIterationField(f: Field): Field {
    return Array.isArray(f.sample) ? f : { ...f, sample: [f.sample], perIteration: true };
}

/**
 * The same fields under another base: `steps.x.output.subject` becomes
 * `steps.x.output.results[*].output.subject`, children and all. Every field a
 * describer writes starts with its group's base path, so moving the prefix
 * keeps each path's quoting exactly as the builder wrote it.
 */
export function rebaseFields(fields: readonly Field[], from: string, to: string): Field[] {
    return fields.map((f) => {
        const path = f.path === from || f.path.startsWith(`${from}.`) || f.path.startsWith(`${from}[`)
            ? `${to}${f.path.slice(from.length)}`
            : f.path;
        const out: Field = { ...f, path };
        if (f.children) out.children = rebaseFields(f.children, from, to);
        return out;
    });
}
