/**
 * The variable-picker group of a "Flatten a list" step (spec F46): before a
 * run, `steps.<id>.output.items[*].<key>` for every key of the rows the step
 * makes from the sample (the shared flattenShape, the same rows the runner
 * makes), plus the plain numbers `count`, `inputCount` and `emptyCount`.
 */
import { appendKey } from '@shared/expr/path.mjs';
import { flattenShape } from '@shared/expr/flatten.mjs';
import { fieldFor, isRecord, type Field } from './fieldTree';

type Step = { id: string; label?: string; arrayRef?: unknown; [key: string]: unknown };

export interface FlattenGroup {
    id: string;
    label: string;
    kind: 'collection';
    basePath: string;
    sample: Record<string, unknown>;
    fields: Field[];
}

/** The fields of the output envelope: `items` opens into one row's columns. */
function envelopeFields(base: string, row: Record<string, unknown>, sample: Record<string, unknown>): Field[] {
    return Object.entries(sample).map(([k, v]) => {
        const path = appendKey(base, k) as string;
        if (k === 'items' && Object.keys(row).length) return fieldFor(k, path, v);
        return { key: k, path, sample: v };
    });
}

/** One flatten step as the tree-display shape every describer returns. */
export function describeFlatten(step: Step, sampleRoot: unknown = null): FlattenGroup {
    const shape = sampleRoot ? flattenShape(sampleRoot, step) : {};
    const row = isRecord(shape) ? (shape as Record<string, unknown>) : {};
    const base = `steps.${step.id}.output`;
    const sample = { items: Object.keys(row).length ? [row] : [], count: 0, inputCount: 0, emptyCount: 0 };
    return {
        id: step.id,
        label: step.label || 'Flatten a list',
        kind: 'collection',
        basePath: base,
        sample,
        fields: envelopeFields(base, row, sample),
    };
}
