import { useState, type ComponentType, type ReactNode } from 'react';
import { appendKey } from '@shared/expr/path.mjs';
import { ChevronDown, ChevronRight, ChevronUp, CircleAlert, X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import FieldKindIconJs from '../mapping/FieldKindIcon';
import { kindOfValue as kindOfValueJs } from '../mapping/fieldKinds';
import { humanizeFieldKey as humanizeFieldKeyJs } from '../flow/displayHelpers';
import { readableValue } from '../mapping/upstream/fieldTree';
import { fieldText } from './cellSummary';
import { isTechnicalKey } from './columns';
import NestedTable, { CARD, NESTED } from './NestedTable';
import { detailParts } from './perItem';
import { isPlainObject, scalarText } from './valueHelpers';

const FieldKindIcon = FieldKindIconJs as unknown as ComponentType<{ kind: string; size?: number; className?: string }>;
const kindOfValue = kindOfValueJs as (v: unknown) => string;
const humanizeFieldKey = humanizeFieldKeyJs as (key: string) => string;

type OpenList = ((path: string, label: string) => void) | null;

/**
 * Is `path` the path the view just came back from, or a group it lies in?
 * Those start open, so the list's "Show all" is on screen again to take focus.
 */
function leadsTo(path: string, reveal: string | null): boolean {
    return !!reveal && (reveal === path || reveal.startsWith(`${path}.`) || reveal.startsWith(`${path}[`));
}

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
    /** A row of a step that ran once per item: its output's fields, Incoming aside. */
    perItem?: boolean;
    /** Opens a nested list as a level of the large view ("Show all 16 rows"). */
    onOpenList?: OpenList;
    /** The list path the view just came back up from: it opens again, with every fold around it. */
    revealPath?: string | null;
}

/**
 * One row, every field, as a tree (artboard 4d, right): groups and tables
 * fold open, deeper levels start closed, technical fields wait behind one
 * line at the bottom. ↑/↓ page through the rows.
 */
export default function RowDetail({
    row, title, index, total, canPrev, canNext, onPrev, onNext, onClose, perItem = false, onOpenList = null, revealPath = null,
}: RowDetailProps) {
    const { t } = useTranslation();
    const navBtn = 'w-6 h-6 rounded-md border border-[var(--border-default)] grid place-items-center hover:bg-[var(--bg-tertiary)] disabled:opacity-40';
    return (
        <aside className="border-l border-[var(--border-default)] bg-[var(--bg-primary)] flex flex-col min-h-0 min-w-0" data-testid="output-row-detail" data-detail-row={index}>
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
                {perItem && isPlainObject(row)
                    ? <PerItemEntries row={row} index={index} onOpenList={onOpenList} reveal={revealPath} />
                    : <PlainEntries row={row} onOpenList={onOpenList} reveal={revealPath} />}
            </div>
        </aside>
    );
}

interface EntriesProps {
    onOpenList: OpenList;
    reveal: string | null;
}

/** An ordinary row: its own fields, technical ones behind one line. */
function PlainEntries({ row, onOpenList, reveal }: EntriesProps & { row: unknown }) {
    const entries = isPlainObject(row) ? Object.entries(row) : [['value', row] as [string, unknown]];
    const readable = entries.filter(([k]) => !isTechnicalKey(k));
    const technical = entries.filter(([k]) => isTechnicalKey(k));
    return (
        <>
            {readable.map(([k, v]) => <FieldNode key={k} name={k} value={v} depth={0} path={k} onOpenList={onOpenList} reveal={reveal} />)}
            <Technical count={technical.length} startOpen={technical.some(([k]) => leadsTo(k, reveal))}>
                {technical.map(([k, v]) => <FieldNode key={k} name={k} value={v} depth={0} path={k} onOpenList={onOpenList} reveal={reveal} />)}
            </Technical>
        </>
    );
}

/**
 * A row of a step that ran once per item: what went wrong (if it did), the
 * fields it returned, the item it ran for ("Incoming", folded unless the item
 * failed) and the technical rest. `index` and `status` never show.
 */
function PerItemEntries({ row, index, onOpenList, reveal }: EntriesProps & { row: Record<string, unknown>; index: number }) {
    const { t } = useTranslation();
    const parts = detailParts(row);
    const output = readableValue(row.output);
    const pathOf = (k: string) => (isPlainObject(output) && k in output ? appendKey(parts.base, k) : k);
    const broke = parts.problem != null;
    const node = { depth: 0, onOpenList, reveal };
    return (
        <>
            {broke && <ProblemBlock text={parts.problem || ''} />}
            {parts.main.map(([k, v]) => <FieldNode key={k} name={k} value={v} path={appendKey(parts.base, k)} {...node} />)}
            {parts.result !== undefined && (
                <FieldNode name="output" label={t('automations.output.col_result', 'Result')} value={parts.result} path={parts.base} {...node} />
            )}
            {/* Keyed per row: the details stay mounted from row to row, and each
                row's Incoming starts folded, or open when that row failed. */}
            {parts.incoming !== undefined && (
                <FieldNode key={`incoming:${index}:${broke}`} name="item" label={t('automations.ndv.incoming', 'Incoming')} value={parts.incoming} path="item" startOpen={broke} {...node} />
            )}
            <Technical count={parts.technical.length} startOpen={parts.technical.some(([k]) => leadsTo(pathOf(k), reveal))}>
                {parts.technical.map(([k, v]) => <FieldNode key={k} name={k} value={v} path={pathOf(k)} {...node} />)}
            </Technical>
        </>
    );
}

/** A failed item's message, in full, in the error colour. */
function ProblemBlock({ text }: { text: string }) {
    const { t } = useTranslation();
    return (
        <div className="shrink-0 flex gap-2 px-2.5 py-2 rounded-lg border border-[color-mix(in_srgb,var(--error)_35%,transparent)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)] text-[var(--error)]" data-testid="row-detail-problem">
            <CircleAlert size={13} aria-hidden className="shrink-0 mt-px" />
            <div className="min-w-0">
                <div className="font-semibold">{t('automations.output.col_problem', 'Problem')}</div>
                <div className="whitespace-pre-wrap break-words">{text || '—'}</div>
            </div>
        </div>
    );
}

/** "+ 2 technical", and the fields themselves once opened. */
function Technical({ count, startOpen = false, children }: { count: number; startOpen?: boolean; children: ReactNode }) {
    const { t } = useTranslation();
    const [show, setShow] = useState(startOpen);
    if (count === 0) return null;
    return (
        <>
            <button type="button" onClick={() => setShow(s => !s)} className="self-start text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-0.5 pt-0.5">
                {show
                    ? t('automations.output.hide_technical', 'Hide technical fields')
                    : t('automations.output.n_technical', '+ {count} technical', { count })}
            </button>
            {show && children}
        </>
    );
}

const LEAF = 'shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] min-w-0';

interface FieldNodeProps {
    name: string;
    value: unknown;
    depth: number;
    path: string;
    onOpenList: OpenList;
    /** A label of its own ("Incoming"); else the field name, humanised. */
    label?: string;
    /** Open from the start; by default only top-level groups and tables are. */
    startOpen?: boolean;
    /** The list path the view came back up from: it and the groups around it start open. */
    reveal?: string | null;
}

function FieldNode({ name, value: raw, depth, path, onOpenList, label: own, startOpen, reveal = null }: FieldNodeProps) {
    const { t } = useTranslation();
    // Top-level groups and tables start open, deeper ones closed, and so does
    // the way back to the list the view just came up from.
    const [open, setOpen] = useState(() => (startOpen ?? depth === 0) || leadsTo(path, reveal));
    const label = own || humanizeFieldKey(name) || name;
    // JSON text (a body, an AI answer, text inside text) reads as what it encodes.
    const value = readableValue(raw);
    const kind = kindOfValue(value);
    const Chevron = open ? ChevronDown : ChevronRight;

    if (kind === 'group' && isPlainObject(value)) {
        const fields = Object.entries(value);
        return (
            <div className={depth === 0 ? CARD : NESTED} data-testid="row-detail-field">
                <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className={`w-full flex items-center gap-2 px-2.5 py-[7px] text-left ${depth === 0 && open ? 'border-b border-[var(--border-default)]' : ''}`}>
                    <Chevron size={13} aria-hidden className="shrink-0" />
                    <FieldKindIcon kind="group" size={13} className="shrink-0 text-[var(--text-secondary)]" />
                    <span className="font-semibold truncate">{label}</span>
                    <span className="text-[var(--text-tertiary)] shrink-0">{fields.length === 1
                        ? t('automations.output.group_field', 'group · 1 field')
                        : t('automations.output.group_fields', 'group · {count} fields', { count: fields.length })}</span>
                </button>
                {open && (
                    <div className="pl-5 py-0.5">
                        {fields.map(([k, v]) => <FieldNode key={k} name={k} value={v} depth={depth + 1} path={appendKey(path, k)} onOpenList={onOpenList} reveal={reveal} />)}
                    </div>
                )}
            </div>
        );
    }
    if (kind === 'table' && Array.isArray(value)) {
        return <NestedTable label={label} rows={value} open={open} onToggle={() => setOpen(o => !o)} framed={depth === 0} path={path} onOpenList={onOpenList} />;
    }
    return <LeafField kind={kind} value={value} name={name} label={label} depth={depth} />;
}

/** A plain value, or a list of plain values, on one line; a size as "1.5 KB", as in the grid. */
function LeafField({ kind, value, name, label, depth }: { kind: string; value: unknown; name: string; label: string; depth: number }) {
    const { t } = useTranslation();
    const list = kind === 'list' && Array.isArray(value) ? value : null;
    const text = list ? list.map(v => scalarText(v)).join(' · ') : fieldText(value, name);
    return (
        <div className={depth === 0 ? LEAF : 'shrink-0 flex items-center gap-2 px-2.5 py-[5px] min-w-0'} data-testid="row-detail-field">
            <FieldKindIcon kind={kind} size={13} className="shrink-0 text-[var(--text-secondary)]" />
            <span className={`${depth === 0 ? 'font-medium' : ''} shrink-0`}>{label}</span>
            {list && (
                <span className="text-[var(--text-tertiary)] shrink-0">{t('automations.output.list_of', 'list of {count}', { count: list.length })}</span>
            )}
            <span className="ml-auto text-[var(--text-tertiary)] truncate max-w-[200px]" title={text}>{text || '—'}</span>
        </div>
    );
}
