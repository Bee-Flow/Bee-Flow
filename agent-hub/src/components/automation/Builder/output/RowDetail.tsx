import { useState, type ComponentType } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import FieldKindIconJs from '../mapping/FieldKindIcon';
import { kindOfValue as kindOfValueJs } from '../mapping/fieldKinds';
import { humanizeFieldKey as humanizeFieldKeyJs } from '../flow/displayHelpers';
import { cellText } from './cellSummary';
import { isTechnicalKey } from './columns';
import { isPlainObject, scalarText, type PlainObject } from './valueHelpers';

const FieldKindIcon = FieldKindIconJs as unknown as ComponentType<{ kind: string; size?: number; className?: string }>;
const kindOfValue = kindOfValueJs as (v: unknown) => string;
const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;

/** Rows of a nested table the detail shows before "+ n lines". */
const NESTED_ROWS = 5;

interface RowDetailProps {
    row: unknown;
    title: string;
    index: number;
    total: number;
    canPrev: boolean;
    canNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    onClose: () => void;
}

/**
 * One row, every field, as a tree (artboard 4d, right): groups and tables
 * fold open, deeper levels start closed, technical fields wait behind one
 * line at the bottom. ↑/↓ page through the rows.
 */
export default function RowDetail({ row, title, index, total, canPrev, canNext, onPrev, onNext, onClose }: RowDetailProps) {
    const { t } = useTranslation();
    const [showTech, setShowTech] = useState(false);
    const entries = isPlainObject(row) ? Object.entries(row) : [['value', row] as [string, unknown]];
    const readable = entries.filter(([k]) => !isTechnicalKey(k));
    const technical = entries.filter(([k]) => isTechnicalKey(k));
    const navBtn = 'w-6 h-6 rounded-md border border-[var(--border-default)] grid place-items-center hover:bg-[var(--bg-tertiary)] disabled:opacity-40';
    return (
        <aside className="border-l border-[var(--border-default)] bg-[var(--bg-primary)] flex flex-col min-h-0 min-w-0" data-testid="output-row-detail">
            <div className="px-3.5 py-2.5 border-b border-[var(--border-default)] flex items-center gap-2">
                <div className="font-semibold text-[13px] truncate">{title || t('automations.output.row_n', 'Row {n}', { n: index + 1 })}</div>
                <span className="text-[var(--text-tertiary)] shrink-0">{t('automations.output.row_of', 'row {n} of {total}', { n: index + 1, total })}</span>
                <div className="ml-auto flex gap-0.5 shrink-0">
                    <button type="button" onClick={onPrev} disabled={!canPrev} className={navBtn} aria-label={t('automations.output.prev_row', 'Previous row')}><ChevronUp size={13} /></button>
                    <button type="button" onClick={onNext} disabled={!canNext} className={navBtn} aria-label={t('automations.output.next_row', 'Next row')}><ChevronDown size={13} /></button>
                    <button type="button" onClick={onClose} className="w-6 h-6 grid place-items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]" aria-label={t('automations.output.close_detail', 'Close row details')}><X size={13} /></button>
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3.5 py-2.5 flex flex-col gap-1.5">
                {readable.map(([k, v]) => <FieldNode key={k} name={k} value={v} depth={0} path={k} />)}
                {technical.length > 0 && (
                    <button type="button" onClick={() => setShowTech(s => !s)} className="self-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-0.5 pt-0.5">
                        {showTech
                            ? t('automations.output.hide_technical', 'Hide technical fields')
                            : t('automations.output.n_technical', '+ {count} technical', { count: technical.length })}
                    </button>
                )}
                {showTech && technical.map(([k, v]) => <FieldNode key={k} name={k} value={v} depth={0} path={k} />)}
            </div>
        </aside>
    );
}

const CARD = 'rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden';
const LEAF = 'flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] min-w-0';

function FieldNode({ name, value, depth, path }: { name: string; value: unknown; depth: number; path: string }) {
    const { t } = useTranslation();
    // Top-level groups and tables start open, deeper ones closed.
    const [open, setOpen] = useState(depth === 0);
    const label = humanizeFieldKey(name) || name;
    const kind = kindOfValue(value);
    const Chevron = open ? ChevronDown : ChevronRight;

    if (kind === 'group' && isPlainObject(value)) {
        const fields = Object.entries(value);
        return (
            <div className={depth === 0 ? CARD : ''}>
                <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className={`w-full flex items-center gap-2 px-2.5 py-[7px] text-left ${depth === 0 && open ? 'border-b border-[var(--border-default)]' : ''}`}>
                    <Chevron size={13} aria-hidden className="shrink-0" />
                    <FieldKindIcon kind="group" size={13} className="shrink-0 text-[var(--text-secondary)]" />
                    <span className="font-semibold truncate">{label}</span>
                    <span className="text-[var(--text-tertiary)] shrink-0">{t('automations.output.group_fields', 'group · {count} fields', { count: fields.length })}</span>
                </button>
                {open && (
                    <div className="pl-5 py-0.5">
                        {fields.map(([k, v]) => <FieldNode key={k} name={k} value={v} depth={depth + 1} path={`${path}.${k}`} />)}
                    </div>
                )}
            </div>
        );
    }
    if (kind === 'table' && Array.isArray(value)) {
        return <NestedTable label={label} rows={value} open={open} onToggle={() => setOpen(o => !o)} framed={depth === 0} />;
    }
    const text = kind === 'list' && Array.isArray(value)
        ? value.map(v => scalarText(v)).join(' · ')
        : cellText(value);
    return (
        <div className={depth === 0 ? LEAF : 'flex items-center gap-2 px-2.5 py-[5px] min-w-0'}>
            <FieldKindIcon kind={kind} size={13} className="shrink-0 text-[var(--text-secondary)]" />
            <span className={`${depth === 0 ? 'font-medium' : ''} shrink-0`}>{label}</span>
            {kind === 'list' && Array.isArray(value) && (
                <span className="text-[var(--text-tertiary)] shrink-0">{t('automations.output.list_of', 'list of {count}', { count: value.length })}</span>
            )}
            <span className="ml-auto text-[var(--text-tertiary)] truncate max-w-[200px]" title={text}>{text || '—'}</span>
        </div>
    );
}

function NestedTable({ label, rows, open, onToggle, framed }: { label: string; rows: unknown[]; open: boolean; onToggle: () => void; framed: boolean }) {
    const { t } = useTranslation();
    const objects = rows.filter(isPlainObject) as PlainObject[];
    const keys: string[] = [];
    for (const o of objects.slice(0, 50)) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
    const readable = keys.filter(k => !isTechnicalKey(k));
    const cols = (readable.length ? readable : keys).slice(0, 3);
    const shown = objects.slice(0, NESTED_ROWS);
    return (
        <div className={framed ? CARD : ''}>
            <button type="button" aria-expanded={open} onClick={onToggle} className={`w-full flex items-center gap-2 px-2.5 py-[7px] text-left ${framed && open ? 'border-b border-[var(--border-default)]' : ''}`}>
                {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                <FieldKindIcon kind="table" size={13} className="shrink-0 text-[var(--text-secondary)]" />
                <span className="font-semibold truncate">{label}</span>
                <span className="text-[var(--text-tertiary)] shrink-0">{t('automations.output.rows_cols', '{rows} rows · {cols} columns', { rows: rows.length, cols: keys.length })}</span>
            </button>
            {open && (
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="text-[var(--text-tertiary)] font-semibold">
                            {cols.map((k, i) => (
                                <th key={k} className={`py-[5px] font-semibold ${i === 0 ? 'text-left pl-8 pr-1.5' : 'text-right px-1.5'}`}>{humanizeFieldKey(k)}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((r, ri) => (
                            <tr key={ri}>
                                {cols.map((k, i) => (
                                    <td key={k} className={`py-1 ${i === 0 ? 'pl-8 pr-1.5 max-w-0 w-full truncate' : 'text-right px-1.5 whitespace-nowrap'}`}>{cellText(r[k]) || '—'}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {open && rows.length > NESTED_ROWS && (
                <div className="pl-8 pr-2.5 pt-[5px] pb-[7px] text-[var(--text-tertiary)]">
                    {t('automations.output.more_lines', '+ {count} lines', { count: rows.length - NESTED_ROWS })}
                </div>
            )}
        </div>
    );
}
