import type { TranslateFn } from '../../../../../hooks/useTranslation';
import type { SourceMirror } from '../useSourceMirror';
import type { Field, UsageReader } from '../ColumnDesigner.types';

/** One refusal from the managed contract, as a sentence in the reader's language. */
export function managedProblemText(t: TranslateFn, problem: { reason: string; key?: string; type?: string }) {
    switch (problem.reason) {
        case 'retyped':
            return t('datatables.managed_retyped', '“{key}” is filled in automatically and has to stay a {type} column.', problem);
        case 'unique':
            return t('datatables.managed_unique', '“{key}” has to stay unique — without it every refresh would add a second row instead of replacing the first.', problem);
        case 'required':
            return t('datatables.managed_required', '“{key}” has to stay required — it is filled in automatically.', problem);
        case 'definition_owned':
            return t('datatables.managed_definition_owned', 'The columns of this table come from the form.');
        default:
            return t('datatables.managed_missing', '“{key}” is part of how this table is filled in automatically. It cannot be removed or renamed.', problem);
    }
}

/**
 * What a platform-owned column is FOR, in prose (artboard 1d).
 *
 * Named per column rather than a blanket "filled in automatically", because
 * the two that matter are not obvious: `cache_key` is what a later run looks
 * the answer up by, and `fetched_at` is where the retention window counts
 * from — delete the wrong thing and either the cache never hits again or the
 * rows never expire.
 */
/**
 * What a MIRROR column is, for its hint: where it came from (the source),
 * which relation fills it in, or — on a spreadsheet — that it is the key
 * column a row is recognised by. `mirror.source` carries the relations and
 * the key column; the source's own type per column is not shipped to the
 * client, so the hint names the source and the role, not the type.
 */
export function sourceColumnInfo(t: TranslateFn, field: Field, mirror: SourceMirror | null | undefined, sourceName: string) {
    const source = (mirror && mirror.source) || null;
    const relations = (source && source.relations) || [];
    const rel = relations.find((r) => r.fieldId === field.id);
    if (rel && rel.kind === 'nc') return t('datatables.nc_column_relation_nc', 'from Nextcloud · a link to a row of another linked table');
    if (rel && rel.kind === 'match') return t('datatables.nc_column_relation_declared', 'filled in here · matched on a column of another linked table');
    const label = relations.find((r) => r.kind === 'nc' && r.labelFieldId === field.id);
    if (label) return t('datatables.nc_column_label', 'filled in here · the name of the linked row');
    if (source && source.keyColumn && source.keyColumn.fieldId === field.id) {
        return t('datatables.ss_column_key', 'from {source} · the key column that identifies a row', { source: sourceName });
    }
    return t('datatables.src_column_hint', 'from {source}', { source: sourceName });
}

export function managedHint(t: TranslateFn, kind: string | null, key: string) {
    if (kind === 'form_answers') {
        if (key === 'run_id') return t('datatables.frm_hint_run_id', 'fixed · the run the submission started');
        if (key === 'completed_at') return t('datatables.frm_hint_completed_at', 'fixed · when the last page was answered');
        return null;
    }
    if (kind !== 'http_cache') return null;
    switch (key) {
        case 'cache_key': return t('datatables.managed_hint.cache_key', 'fixed · what a later run finds the answer back by');
        case 'response_status': return t('datatables.managed_hint.response_status', 'fixed · the answer code the service gave');
        case 'response_body': return t('datatables.managed_hint.response_body', 'fixed · what the service sent back');
        case 'fetched_at': return t('datatables.managed_hint.fetched_at', 'fixed · the retention window counts from here');
        case 'request_host': return t('datatables.managed_hint.request_host', 'fixed · which service was asked');
        case 'request_path': return t('datatables.managed_hint.request_path', 'fixed · what was asked for');
        case 'request_method': return t('datatables.managed_hint.request_method', 'fixed · how it was asked');
        case 'response_headers': return t('datatables.managed_hint.response_headers', 'fixed · what the service said about its answer');
        default: return t('datatables.managed_hint.other', 'fixed · filled in automatically');
    }
}

/** The first three consumer names, and how many more there are. */
export function nameList(list: UsageReader[]) {
    const names = list.slice(0, 3).map(u => u.consumerTitle || u.automationTitle || u.automationId).join(', ');
    return list.length > 3 ? `${names} +${list.length - 3}` : names;
}
