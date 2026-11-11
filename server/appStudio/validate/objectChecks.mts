/**
 * App Studio validator: a prop or list-item key whose value is a small fixed object
 * (`type: 'object'`, componentSpecs/objectShapes.js). The value must be exactly what the
 * canonicalizer would store; each repair the cleaner would make is one error.
 */

import { createRequire } from 'node:module';
import { shapeProblems } from '../../shared/format/formatClean.mjs';
import type { Finding } from '../definitionKeyRegistry.mts';

type Cleaner = (raw: unknown, push: (code: string, path: string, message: string) => void, path: string) => unknown;

const nodeRequire = createRequire(import.meta.url);
const { objectShapeOf } = nodeRequire('../componentSpecs/objectShapes.js') as {
    objectShapeOf: (spec: unknown) => { clean: Cleaner } | null;
};

/**
 * Check `value` against the object shape of `spec`. Returns false when `spec` is not an object
 * key (the caller checks it its own way), true when it was checked here.
 */
export function checkObjectValue(spec: unknown, value: unknown, path: string, pushE: (f: Finding) => void): boolean {
    const shape = objectShapeOf(spec);
    if (!shape) return false;
    if (value === undefined || value === null) return true;
    for (const problem of shapeProblems(value, shape.clean, path)) {
        pushE({
            code: 'prop.object_invalid', severity: 'error', path: problem.path, message: problem.message,
            hint: 'Run the definition through canonicalize: it drops what cannot be used.',
        });
    }
    return true;
}
