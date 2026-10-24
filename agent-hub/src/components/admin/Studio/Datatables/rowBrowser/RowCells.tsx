import { Link2 } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { DtColumn, DtMirror, DtRow, RowSort } from './rowBrowserModel';
import { ColumnKindIcon } from './typedViews';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { cellText } from '../../AppStudio/tables/rowValues';
import { MANAGED_COLUMNS, columnLabel, rowExpiry } from '../datatableDisplay';

interface HeadCellProps {
    t: TranslateFn;
    label: string;
    title?: string;
    kind: string;
    field: string;
    sort: RowSort;
    onSort: () => void;
    numeric?: boolean;
    muted?: boolean;
}

/**
 * A sortable column heading, with its kind's glyph — artboard 1e. A number
 * column's heading sits over its right-aligned figures (2b); the "Added"
 * heading is muted, as its values are.
 *
 * `title` is the column's real key when the heading is a humanised version of
 * it — the exact spelling stays one hover away for whoever is writing
 * `{{steps.x.output.contact_email}}`. Undefined when the two are the same, so
 * a tooltip never just repeats what is already on screen.
 */
export function HeadCell({ t, label, title, kind, field, sort, onSort, numeric = false, muted = false }: HeadCellProps) {
    return (
        <th className={`${numeric ? 'text-right' : 'text-left'} font-semibold px-3 py-2.5 whitespace-nowrap`}
            style={{ color: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
            title={title}>
            <button type="button" onClick={onSort}
                className="inline-flex items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [outline-color:var(--accent-primary)]!"
                aria-label={t('datatables.sort_by', 'Sort by {name}', { name: label })}>
                <ColumnKindIcon kind={kind} size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                {label}
                {sort.field === field && <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>}
            </button>
        </th>
    );
}

const PILL: CSSProperties = { padding: '1px 7px', borderRadius: 999 };

interface RelationCellProps {
    t: TranslateFn;
    column: DtColumn;
    row: DtRow;
    columns: DtColumn[];
    mirror: DtMirror | null;
}

/**
 * A relation cell on a mirror: the LABEL of the linked row, not its id.
 *
 * The label is a column of this same row — the `<key>_label` the engine
 * fills beside a Nextcloud relation, or the local match column a declared
 * relation was matched on — so no second request is needed. Falls back to
 * `#<id>` when there is an id and no label, and to a dash when the row has
 * no link at all. A relation is derived: it is not edited here (the column
 * it derives from is), which is what the title says.
 */
export function RelationCell({ t, column, row, columns, mirror }: RelationCellProps) {
    const id = row[column.key];
    const relations = (mirror && mirror.source && mirror.source.relations) || [];
    const rel = relations.find(r => r.fieldId === column.id);
    let label: unknown = null;
    if (rel && rel.kind === 'nc') {
        const labelCol = columns.find(c => c.id === rel.labelFieldId);
        label = labelCol ? row[labelCol.key] : null;
    } else if (rel && rel.kind === 'match') {
        const localCol = columns.find(c => c.id === rel.localFieldId);
        label = localCol ? row[localCol.key] : null;
    }
    if (id === null || id === undefined || id === '') return <span className="text-[var(--text-tertiary)]">—</span>;
    return (
        <span
            className="inline-flex items-center gap-1 text-[11px] max-w-full"
            style={{ ...PILL, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
            title={rel && rel.kind === 'match'
                ? t('datatables.nc_relation_derived', 'Filled in from another column — change that column instead.')
                : t('datatables.nc_relation_cell_title', 'A row of the linked table')}
        >
            <Link2 className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{label !== null && label !== undefined && label !== '' ? String(label) : `#${id}`}</span>
        </span>
    );
}

const isEmptyChoice = (value: unknown) => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);

interface ManagedCellProps {
    t: TranslateFn;
    managedKind: string | null | undefined;
    column: DtColumn;
    row: DtRow;
}

/**
 * A cell, with the two managed columns that are not really text.
 *
 * `response_status` is an HTTP answer code, and 200-vs-429 is the whole
 * reason someone opens a cache table — so it wears the success/error tint
 * rather than sitting in the row as a number. The keys come from
 * `MANAGED_COLUMNS`, so a table whose contract changes cannot leave a
 * renderer pointing at a column that is gone.
 */
export function ManagedCell({ t, managedKind, column, row }: ManagedCellProps) {
    const value = row[column.key];
    const managedColumns = (MANAGED_COLUMNS as Record<string, Array<{ key: string }> | undefined>)[managedKind as string];
    const managed = (managedColumns || []).some(f => f.key === column.key);
    if (managed && column.key === 'response_status' && value !== null && value !== undefined && value !== '') {
        const code = Number(value);
        const ok = Number.isFinite(code) && code >= 200 && code < 300;
        const tone = ok ? 'success' : 'error';
        return (
            <span
                className="inline-flex items-center text-[11px] font-semibold"
                style={{
                    ...PILL,
                    background: ok
                        ? 'color-mix(in srgb, var(--success) 14%, transparent)'
                        : 'color-mix(in srgb, var(--error) 12%, transparent)',
                    color: ok ? 'var(--success-ink)' : 'var(--error-ink)',
                }}
                title={t('datatables.managed_status', 'The answer code the service gave')}
                data-tone={tone}
            >
                {String(value)}
            </span>
        );
    }
    if (managed && column.key === 'request_method') {
        return <span className="font-mono uppercase">{cellText(value, column)}</span>;
    }
    // An empty choice reads as what it is — "no status yet" — in a dimmed,
    // dashed pill (2b), not as a dash that could pass for a value.
    if ((column.type === 'select' || column.type === 'multiselect') && isEmptyChoice(value)) {
        return (
            <span className="inline-flex items-center text-[11px] whitespace-nowrap [padding:2px_8px] [border-radius:999px] [border:1px_dashed_var(--border-default)] [color:var(--text-tertiary)]!"
                data-testid="cell-empty-choice">
                {t('datatables.cell_no_choice', 'no {name} yet', { name: columnLabel(column).toLowerCase() })}
            </span>
        );
    }
    return <>{cellText(value, column)}</>;
}

const SOON: CSSProperties = {
    ...PILL,
    background: 'color-mix(in srgb, var(--warning) 16%, transparent)',
    color: 'var(--warning-ink)',
};

/**
 * When this row goes (artboard 1e's "Verloopt" column).
 *
 * Derived, not stored: the server keeps no per-row expiry, the sweep works
 * it out from `retentionDays` + `retentionField` when it runs. So the column
 * only appears when BOTH are set, and it uses exactly those two — a
 * countdown from a column the sweep does not read would be a confident lie.
 */
export function ExpiryCell({ t, row, retention }: { t: TranslateFn; row: DtRow; retention: { retentionDays: number; retentionField: string } }) {
    const e = rowExpiry(row, retention) as { overdue?: boolean; days: number } | null;
    if (!e) return <span className="text-[var(--text-tertiary)]">—</span>;
    if (e.overdue) {
        return <span className="text-[11px] font-semibold" style={SOON}>{t('datatables.expiry_due', 'due to go')}</span>;
    }
    if (e.days <= 7) {
        return (
            <span className="text-[11px] font-semibold" style={SOON}>
                {e.days <= 1
                    ? t('datatables.expiry_today', 'today')
                    : t('datatables.expiry_in_days', 'in {n} days', { n: e.days })}
            </span>
        );
    }
    return (
        <span className="text-[var(--text-secondary)]">
            {t('datatables.expiry_in_days', 'in {n} days', { n: e.days })}
        </span>
    );
}
