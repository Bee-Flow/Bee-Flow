/**
 * What the comparison sheet lists, pure: the plain-language phrases (the
 * web's summarizeDefinitionDiff, formState/diffSummary.ts), and — when two
 * saved versions are compared through GET /:id/versions/:a/diff/:b — the
 * server's own list of which steps were added, removed or changed, by name.
 * Or, in the raw view, the changed lines (versionsModel.ts).
 */

import type { FlowVersionDiff } from '@/features/flow-editor/api';
import { summarizeDefinitionDiff } from '@/features/flow-editor/formState/diffSummary';
import { buildStepLabelMap, type DefinitionInput, type Translate } from '@/features/flow-editor/model';

import { definitionDiff, type HunkLine } from './versionsModel';

export type DiffItem = { kind: 'phrase'; text: string; key: string } | { kind: 'none'; key: string } | HunkLine;

function names(ids: readonly string[], labels: Map<string, string>): string {
    return ids.map((id) => labels.get(id) || id).join(', ');
}

/** The server's step lists, as sentences with the steps' names. */
export function serverStepItems(summary: FlowVersionDiff['summary'] | null | undefined, before: DefinitionInput, after: DefinitionInput, t: Translate): DiffItem[] {
    if (!summary) return [];
    const labels = new Map([...buildStepLabelMap(before), ...buildStepLabelMap(after)]);
    const { added, removed, changed } = summary.steps;
    const out: DiffItem[] = [];
    if (added.length) out.push({ kind: 'phrase', key: 'srv-added', text: t('mobile.flow.versions.added_steps', 'Added: {names}', { names: names(added, labels) }) });
    if (removed.length) out.push({ kind: 'phrase', key: 'srv-removed', text: t('mobile.flow.versions.removed_steps', 'Removed: {names}', { names: names(removed, labels) }) });
    if (changed.length) out.push({ kind: 'phrase', key: 'srv-changed', text: t('mobile.flow.versions.changed_steps', 'Changed: {names}', { names: names(changed, labels) }) });
    return out;
}

/**
 * The sheet's rows. `before` is what the version is compared WITH (the
 * current automation, or an older save), `after` the version opened.
 */
export function diffItems(
    before: DefinitionInput,
    after: DefinitionInput,
    { raw, summary = null, t }: { raw: boolean; summary?: FlowVersionDiff['summary'] | null; t: Translate },
): DiffItem[] | null {
    if (!before || !after) return null;
    if (raw) return definitionDiff(before, after);
    const phrases = summarizeDefinitionDiff(before, after).map((text, i): DiffItem => ({ kind: 'phrase', text, key: `p-${i}` }));
    const detail = serverStepItems(summary, before, after, t);
    return phrases.length || detail.length ? [...phrases, ...detail] : [{ kind: 'none', key: 'none' }];
}
