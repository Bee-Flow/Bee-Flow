/**
 * "Suggest outputs", the part the web keeps inline in RouteAssist.jsx and
 * routeEditors.jsx, pure: the sample rows a suggestion is counted against,
 * where the rules came from in one line, and which wired outputs an accept
 * would cost. The suggestion itself is formState/routeIntents (suggestOutputs,
 * matchCounts).
 */

import type { TranslateFn } from '@/core/i18n';
import { walkPath } from '@/features/flow-editor/bindings';
import type { Suggestion } from '@/features/flow-editor/formState';
import type { Route } from '@/features/flow-editor/model';

/**
 * The rows the editor ALREADY has for a list-mode node — whatever the step
 * above last produced, through the path the rules are evaluated against —
 * never anything invented. Null for a whole-run node: there is no list.
 */
export function sampleRowsFor(route: Pick<Route, 'mode' | 'source'>, sampleRoot: unknown): unknown[] | null {
    if (route.mode !== 'items' || !route.source) return null;
    const value = walkPath(route.source, sampleRoot);
    return Array.isArray(value) ? value : null;
}

/** "Split by file type — 3 outputs, using File name:" */
export function previewHeading(suggestion: Suggestion, t: TranslateFn): string {
    const n = suggestion.rules.length;
    const outputs = n === 1 ? t('mobile.flow.route.assist.one_output_using', 'one output, using') : t('mobile.flow.route.assist.n_outputs_using', '{n} outputs, using', { n });
    const field = suggestion.field?.label || t('mobile.flow.route.assist.this_field', 'this field');
    return `${suggestion.understood} — ${outputs} ${field}:`;
}

/** The wired outputs an accept renames away: a name the suggestion keeps keeps its edge. */
export function losingWires(wiredNames: readonly string[], rules: readonly { name: string }[]): string[] {
    return wiredNames.filter((n) => !rules.some((r) => r.name === n));
}

/** Configured outputs an accept replaces: a rule with a condition. */
export function configuredRules(route: Pick<Route, 'rules'>): number {
    return (route.rules || []).filter((r) => String(r?.expr || '').trim()).length;
}
