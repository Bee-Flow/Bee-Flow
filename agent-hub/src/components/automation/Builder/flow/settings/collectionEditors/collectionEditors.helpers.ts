import { getList } from '@shared/expr/path.mjs';
import { type TranslateParams } from '../../../../../../hooks/useTranslation';
import { listPathLabel } from '../../../mapping/listPathLabel';
import { collectArrayPaths } from '../../../mapping/upstream';
import { fieldLabelText, routeFieldLabel } from '../../../mapping/upstream/routeFieldLabel';
import { humanizeFieldKey } from '../../displayHelpers';
import type { Group } from '../../../mapping/upstream/upstream.types';
import type { ForEachSpec } from '../../../mapping/templateRemedies';

export function retryTriesLabel(n: number) {
    if (n === 1) return 'Once';
    if (n === 2) return 'Twice';
    return `${n} times`;
}

export function retryWaitLabel(ms: number) {
    if (!ms) return 'Straight away';
    const s = Math.round(ms / 100) / 10;
    if (s >= 60 && s % 60 === 0) return `After ${s / 60} minute${s === 60 ? '' : 's'}`;
    return `After ${s} second${s === 1 ? '' : 's'}`;
}

/** The offered values, plus whatever is actually stored if it isn't one of them. */
export function retryChoices(offered: number[], stored: number) {
    return offered.includes(stored) ? offered : [...offered, stored].sort((a, b) => a - b);
}

/**
 * How many rows the waiting is paid on.
 *
 * NOT always one. When the same step also has "Run once per item" ticked the
 * retry is owned PER ROW: execution.js hands a step with a `forEach.overRef`
 * to execForEachStep and then stands back (§WS2.5, `err.foreachHandled`),
 * because retrying the whole fan-out would re-run the rows that already
 * succeeded — so execFlow.js sleeps `backoffMs` between the attempts of EACH
 * row instead. Two tries five seconds apart is ten seconds on a plain step
 * and up to a thousand over a default 100-row fan-out, and the fan-out is
 * exactly where a rate-limited integration earns a retry in the first place.
 * Summing this row on its own printed "10s" in calm grey for the run that was
 * certain to be killed by the 5-minute budget first — the single case the
 * line exists to warn about, and the two rows sit one above the other in the
 * same Advanced section, so the author reads them as one setting.
 *
 * The cap is the runner's own — `Math.min(maxIterations || 100, 1000)`
 * (execFlow.js) — and it counts only once `overRef` is set, because that is
 * the condition execution.js dispatches per item on. A half-filled picker
 * still reads as one step, which is what it still runs as.
 */
export function retryRowCap(forEach: ForEachSpec | undefined) {
    if (!forEach || !forEach.overRef) return 1;
    return Math.min(Number(forEach.maxIterations) || 100, 1000);
}

/**
 * The one-line "Working through ‹gmail search› · Results — 10 items" summary.
 * The list is read the way the run reads it (`getList`, R10), so a list held
 * as JSON text is counted too; such a list, which the quick-picks do not
 * offer, is named by `listPathLabel`. Returns null when the path resolves to
 * nothing, so the form can name the list and say it has no sample yet. A
 * Condition's output reads as its name ("pdf", "Otherwise"), never as its
 * internal key (routeFieldLabel).
 */
export function describeSourceList(source: string | undefined, groups: Group[], previewSample: unknown, t: ((key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) | null = null) {
    const path = String(source || '').trim();
    if (!path) return null;
    // Count from the RESOLVED value: for a `[*]` path a quick-pick's sample is
    // the first element (the collectionItemsFields convention), so its length
    // was the first ROW's size, not the list's.
    const arr = previewSample ? getList(previewSample, path) : null;
    const match = collectArrayPaths(groups, previewSample).find(a => a.path === path);
    if (!match) return arr ? { stepLabel: listPathLabel(path, stepLabels(groups)), fieldLabel: null, count: arr.length } : null;
    const owner = (groups || []).find(g => g.basePath && path.startsWith(g.basePath));
    const counted = arr || (Array.isArray(match.sample) ? match.sample : null);
    return {
        stepLabel: owner?.label || 'Previous step',
        fieldLabel: (t && fieldLabelText(routeFieldLabel(path), t)) || humanizeFieldKey(match.key),
        count: counted ? counted.length : null,
    };
}

/** Step id → label, from the picker groups (`steps.<id>.output`). */
function stepLabels(groups: Group[]) {
    const out = new Map();
    for (const g of groups || []) {
        const m = typeof g?.basePath === 'string' ? g.basePath.split('.') : [];
        if (m[0] === 'steps' && m[1]) out.set(m[1], g.label);
    }
    return out;
}
