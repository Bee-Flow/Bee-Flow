import type { ComponentType } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import FieldKindIconJs from '../mapping/FieldKindIcon';
import { humanizeFieldKey as humanizeFieldKeyJs } from '../flow/displayHelpers';
import { readableValue } from '../mapping/upstream/fieldTree';
import { fieldText } from './cellSummary';
import { isTechnicalKey } from './columns';
import { isPlainObject, scalarText, type PlainObject } from './valueHelpers';

const FieldKindIcon = FieldKindIconJs as unknown as ComponentType<{ kind: string; size?: number; className?: string }>;
const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;

/** Rows and columns of a nested table the row details preview. */
const NESTED_ROWS = 5;
const NESTED_COLS = 3;

// `shrink-0`: these sit in a scrolling flex column, and a flex child with
// overflow-hidden may shrink below its content: a nested table showed its
// header over no rows, a group lost its last field.
export const CARD = 'shrink-0 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden';
export const NESTED = 'shrink-0';

/**
 * A cell of a nested table, short: a record reads as its first two values
 * ("Jan de Wit · jan@acme.example" for a recipient's `emailAddress`), looking
 * through a record that only wraps another. JSON text reads as what it encodes;
 * a size reads as "1.5 KB", as in the grid (fieldText).
 */
function compactText(v: unknown, key: string): string {
    const shown = readableValue(v);
    if (!isPlainObject(shown)) return fieldText(shown, key);
    const parts: string[] = [];
    const walk = (o: PlainObject, depth: number) => {
        for (const x of Object.values(o)) {
            if (parts.length >= 2) return;
            const y = readableValue(x);
            if (isPlainObject(y)) { if (depth < 3) walk(y, depth + 1); }
            else if (y != null && y !== '' && typeof y !== 'object') parts.push(scalarText(y));
        }
    };
    walk(shown, 0);
    return parts.join(' · ');
}

/** "16 rows · 7 columns", "1 row · 1 column": the size of a list, singular where it is one. */
export function rowsAndColumns(t: TranslateFn, rows: number, columns: number): string {
    return [
        rows === 1 ? t('automations.output.one_row', '1 row') : t('automations.output.n_rows', '{count} rows', { count: rows }),
        columns === 1 ? t('automations.output.one_column', '1 column') : t('automations.output.n_columns', '{count} columns', { count: columns }),
    ].join(' · ');
}

interface NestedTableProps {
    label: string;
    rows: unknown[];
    open: boolean;
    onToggle: () => void;
    framed: boolean;
    /** The list's path inside the row (`output.attachments`), for the "Show all" button. */
    path: string;
    /** Opens the whole list as a level of the large view; without it there is no button. */
    onOpenList?: ((path: string, label: string) => void) | null;
}

/**
 * A list of records inside a row's details: a preview of 5 rows × 3 columns,
 * and when that hides anything a button that opens the whole list.
 */
export default function NestedTable({ label, rows, open, onToggle, framed, path, onOpenList = null }: NestedTableProps) {
    const { t } = useTranslation();
    const objects = rows.filter(isPlainObject) as PlainObject[];
    const keys: string[] = [];
    for (const o of objects.slice(0, 50)) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
    const readable = keys.filter(k => !isTechnicalKey(k));
    const cols = (readable.length ? readable : keys).slice(0, NESTED_COLS);
    const shown = objects.slice(0, NESTED_ROWS);
    return (
        <div className={framed ? CARD : NESTED} data-testid="row-detail-field">
            <button type="button" aria-expanded={open} onClick={onToggle} className={`w-full flex items-center gap-2 px-2.5 py-[7px] text-left ${framed && open ? 'border-b border-[var(--border-default)]' : ''}`}>
                {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                <FieldKindIcon kind="table" size={13} className="shrink-0 text-[var(--text-secondary)]" />
                <span className="font-semibold truncate">{label}</span>
                <span className="text-[var(--text-tertiary)] shrink-0">{rowsAndColumns(t, rows.length, keys.length)}</span>
            </button>
            {open && (
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="text-[var(--text-tertiary)] font-semibold">
                            {cols.map((k, i) => (
                                <th key={k} className={`py-[5px] font-semibold whitespace-nowrap ${i === 0 ? 'text-left pl-8 pr-1.5' : 'text-right px-1.5'}`}>{humanizeFieldKey(k)}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((r, ri) => (
                            <tr key={ri}>
                                {cols.map((k, i) => (
                                    <td key={k} className={`py-1 ${i === 0 ? 'pl-8 pr-1.5 max-w-0 w-full truncate' : 'text-right px-1.5 whitespace-nowrap'}`}>{compactText(r[k], k) || '—'}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {open && onOpenList && (
                <ShowAll rows={rows.length} columns={keys.length} onOpen={() => onOpenList(path, label)} path={path} />
            )}
        </div>
    );
}

/** "Show all 16 rows ›", or "Show all 4 columns ›" when every row fits; nothing when nothing is hidden. */
function ShowAll({ rows, columns, onOpen, path }: { rows: number; columns: number; onOpen: () => void; path: string }) {
    const { t } = useTranslation();
    const text = rows > NESTED_ROWS
        ? t('automations.output.show_all_rows', 'Show all {count} rows', { count: rows })
        : columns > NESTED_COLS
            ? t('automations.output.show_all_columns', 'Show all {count} columns', { count: columns })
            : null;
    if (!text) return null;
    return (
        <div className="pl-8 pr-2.5 pt-[5px] pb-[7px]">
            <button
                type="button"
                data-open-path={path}
                onClick={onOpen}
                className="inline-flex items-center gap-0.5 min-h-6 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--type-ai)]"
            >
                {text}
                <ChevronRight size={12} aria-hidden />
            </button>
        </div>
    );
}
