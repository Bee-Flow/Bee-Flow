/**
 * The preview root a Loop's body steps see: the outer root plus the loop's
 * own item, `loop.<itemVar>` — the scope execLoop binds per iteration
 * (outer loop variables stay bound beside it, as at run time).
 *
 * The body editor used to hand its steps the OUTER root, which has no
 * `loop.<itemVar>`: "Each order ▸ Number" previewed nothing, a list picked
 * from the item could not be measured, and a Loop inside the Loop had an
 * empty "Current item" because its list (`loop.order.line_items`) resolved
 * against nothing. With the item in the root, nested loops chain by
 * themselves: the inner body editor gets this root as its outer one.
 */
import { getPath } from '@shared/expr/path.mjs';
import { firstItemPreview, isRecord } from './deepFields';

interface LoopLike { overRef?: string; itemVar?: string; batchSize?: number }

export function loopBodyPreview<T>(loopStep: LoopLike | null | undefined, previewSample: T): T | Record<string, unknown> {
    const overRef = String(loopStep?.overRef || '').trim();
    if (!overRef || !isRecord(previewSample)) return previewSample;
    // The item the first iteration binds, its gaps filled from the other rows
    // (deepFields firstItemPreview), not a blend of every row.
    const element = firstItemPreview(getPath(previewSample, overRef));
    if (element == null) return previewSample;
    const itemVar = loopStep?.itemVar || 'item';
    // A batch (batchSize > 1) binds a SLICE of the list, not one element.
    const value = Math.max(1, Number(loopStep?.batchSize) || 1) > 1 ? [element] : element;
    const loop = isRecord(previewSample.loop) ? previewSample.loop : {};
    return { ...previewSample, loop: { ...loop, [itemVar]: value } };
}
