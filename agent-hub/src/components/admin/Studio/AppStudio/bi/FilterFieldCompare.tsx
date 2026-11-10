import { Columns2, Type } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { FIELD_COMPARE_OPS } from '@shared/expr/filterGroups.mjs';
import { INPUT_CLS } from '../inspector/panels/kit';
import type { FilterField, FilterRow } from './FilterRowsEditor.types';

/**
 * A filter row that compares two columns of the same row:
 * `{ field, op, otherField }` ("spent is greater than budget"). The server
 * compares only columns of the same kind (queryCompilerFilter.compareClass),
 * so the picker offers only those.
 */

const COMPARE_OPS: readonly string[] = FIELD_COMPARE_OPS;

/** True for a row in compare-with-a-field mode (the other field may still be unpicked). */
export function isFieldCompareRow(f: FilterRow): boolean {
    return typeof f.otherField === 'string';
}

/** The ops a column comparison can carry. */
export function isCompareOp(op: string): boolean {
    return COMPARE_OPS.includes(op);
}

/** The kind of a column as the server compares it; null when it cannot be compared at all. */
function compareKind(field: FilterField | null | undefined): string | null {
    const type = field?.type;
    if (!type || type === 'multiselect' || type === 'file' || type === 'computed') return null;
    return type === 'number' || type === 'bool' || type === 'date' || type === 'datetime' ? type : 'text';
}

/** The other columns `field` can be compared with. */
function comparableFields(field: FilterField | null, fields: FilterField[]): FilterField[] {
    const kind = compareKind(field);
    if (!kind) return [];
    return fields.filter((x) => x.key !== field?.key && compareKind(x) === kind);
}

/** The row switched to comparing with another field: no value, no `required`, an op a comparison can carry. */
function toFieldCompare(f: FilterRow): FilterRow {
    return { field: f.field, op: isCompareOp(f.op) ? f.op : 'eq', otherField: '' };
}

/** The row switched back to a fixed value. */
function toValueRow(f: FilterRow): FilterRow {
    return { field: f.field, op: f.op, value: '' };
}

const TOGGLE_CLS = 'shrink-0 px-2 rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]';

interface CompareWithFieldButtonProps {
    /** False where the editor does not offer comparisons at all. */
    offered: boolean;
    f: FilterRow;
    field: FilterField | null;
    fields: FilterField[];
    update: (next: FilterRow) => void;
}

/**
 * The button on a value row that switches it to comparing with another field.
 * Nothing when the row's op is not a comparison or no other field is of the same kind.
 */
export function CompareWithFieldButton({ offered, f, field, fields, update }: CompareWithFieldButtonProps) {
    const { t } = useTranslation();
    if (!offered || !isCompareOp(f.op) || comparableFields(field, fields).length === 0) return null;
    const label = t('studio_apps_filtertree.compare_with_field', 'Compare with another field');
    return (
        <button type="button" onClick={() => update(toFieldCompare(f))} title={label} aria-label={label} className={TOGGLE_CLS}>
            <Columns2 size={13} />
        </button>
    );
}

interface FieldCompareRowProps {
    f: FilterRow;
    field: FilterField | null;
    fields: FilterField[];
    update: (next: FilterRow) => void;
}

/** The second line of a compare row: the other field, and the way back to a fixed value. */
export function FieldCompareRow({ f, field, fields, update }: FieldCompareRowProps) {
    const { t } = useTranslation();
    const options = comparableFields(field, fields);
    // A saved other field the picker would not offer still shows, so it is never silently replaced.
    const saved = f.otherField && !options.some((x) => x.key === f.otherField) ? fields.find((x) => x.key === f.otherField) || { key: f.otherField } : null;
    const back = t('studio_apps_filtertree.use_value', 'Compare with a value');
    return (
        <div className="flex items-stretch gap-1.5">
            <select
                className={`${INPUT_CLS} min-w-0 flex-1`}
                value={f.otherField || ''}
                onChange={(e) => update({ ...f, otherField: e.target.value })}
                aria-label={t('studio_apps_filtertree.other_field', 'Field to compare with')}
            >
                <option value="">{t('studio_apps_filtertree.pick_other_field', 'Pick the other field…')}</option>
                {saved ? <option value={saved.key}>{saved.name || saved.key}</option> : null}
                {options.map((x) => <option key={x.key} value={x.key}>{x.name || x.key}</option>)}
            </select>
            <button type="button" onClick={() => update(toValueRow(f))} title={back} aria-label={back} className={TOGGLE_CLS}>
                <Type size={13} />
            </button>
        </div>
    );
}
