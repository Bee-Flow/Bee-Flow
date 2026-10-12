import type { MouseEvent } from 'react';
import { ChevronRight, Table } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { summariseCell, type Tone } from './cellSummary';
import type { OutputColumn } from './columns';
import { problemText } from './perItem';

const TONE_CLASS: Record<Tone, string> = {
    success: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]',
    error: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)]',
    neutral: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
};

const CHIP = 'inline-flex items-center gap-[5px] px-2 py-0.5 rounded-md bg-[var(--bg-secondary)] whitespace-nowrap';
const OPEN_BTN = `${CHIP} min-h-6 border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--type-ai)]`;

interface SmartCellProps {
    value: unknown;
    col: OutputColumn | null;
    /** Opens the list this cell holds as a level of its own; without it the count is plain text. */
    onOpen?: () => void;
    /** `<rowIndex>:<columnKey>`, so focus can find this button again after going back up. */
    openKey?: string;
    /** The pinned name column: a number in it lines up left, under its header, like every name. */
    pinned?: boolean;
}

/**
 * A cell that holds a list of records: "16 rows". With `onOpen` it is a real
 * button that opens that list (and leaves the row's own click alone).
 */
function RowsCell({ count, onOpen, openKey }: { count: number; onOpen?: () => void; openKey?: string }) {
    const { t } = useTranslation();
    const text = count === 1
        ? t('automations.output.one_row', '1 row')
        : t('automations.output.n_rows', '{count} rows', { count });
    if (!onOpen) {
        return <span className={CHIP} data-cell="table"><Table size={12} aria-hidden />{text}</span>;
    }
    const open = (e: MouseEvent) => { e.stopPropagation(); onOpen(); };
    return (
        <button
            type="button"
            data-cell="table"
            data-open-key={openKey}
            aria-label={count === 1
                ? t('automations.output.open_row_one', 'Open 1 row')
                : t('automations.output.open_rows', 'Open {count} rows', { count })}
            onClick={open}
            className={OPEN_BTN}
        >
            <Table size={12} aria-hidden />
            {text}
            <ChevronRight size={12} aria-hidden className="-mr-0.5" />
        </button>
    );
}

const More = ({ more }: { more: number }) => (more > 0 ? <span className="text-[var(--text-tertiary)] shrink-0">+{more}</span> : null);

/** A record in a cell: its name or first value, and how many fields more. */
function GroupCell({ text, more }: { text: string; more: number }) {
    const { t } = useTranslation();
    return (
        <span className="inline-flex items-center gap-[5px] px-2 py-0.5 rounded-md bg-[var(--bg-secondary)] max-w-full min-w-0" data-cell="group">
            <span className="truncate">{text || t('automations.output.cell_group', 'group')}</span>
            <More more={more} />
        </span>
    );
}

/** A list of plain values in a cell: its first labels as chips. */
function ListCell({ chips, more }: { chips: string[]; more: number }) {
    return (
        <span className="inline-flex items-center gap-1 min-w-0" data-cell="list">
            {chips.map((c, i) => (
                <span key={i} className="px-[7px] rounded-full border border-[var(--border-default)] truncate max-w-[120px]">{c}</span>
            ))}
            <More more={more} />
        </span>
    );
}

/** A per-item step's Problem cell: the failure message, in the error colour, on one line. */
function ProblemCell({ value }: { value: unknown }) {
    const text = problemText(value);
    if (!text) return <span className="text-[var(--text-tertiary)]">—</span>;
    return <span className="block truncate text-[var(--error)]" title={text}>{text}</span>;
}

/** One summarised table cell (artboard 4d): never `[object Object]`. */
export default function SmartCell({ value, col, onOpen, openKey, pinned = false }: SmartCellProps) {
    const { t } = useTranslation();
    if (col?.perItem === 'problem') return <ProblemCell value={value} />;
    if (col?.kind === 'table' && Array.isArray(value) && value.length === 0) {
        return <span className="text-[var(--text-tertiary)] whitespace-nowrap">{t('automations.output.n_rows', '{count} rows', { count: 0 })}</span>;
    }
    const s = summariseCell(value, col);
    switch (s.type) {
    case 'empty':
        return <span className="text-[var(--text-tertiary)]">—</span>;
    case 'status':
        return <span className={`inline-block px-[7px] rounded-full font-semibold whitespace-nowrap ${TONE_CLASS[s.tone]}`}>{s.text}</span>;
    case 'group':
        return <GroupCell text={s.text} more={s.more} />;
    case 'table':
        return <RowsCell count={s.count} onOpen={onOpen} openKey={openKey} />;
    case 'list':
        return <ListCell chips={s.chips} more={s.more} />;
    default:
        return <span className={`block truncate ${s.align === 'right' && !pinned ? 'text-right' : ''}`}>{s.text}</span>;
    }
}
