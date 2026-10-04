import { Table } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { summariseCell, type Tone } from './cellSummary';
import type { OutputColumn } from './columns';

const TONE_CLASS: Record<Tone, string> = {
    success: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success)]',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning)]',
    error: 'bg-[color-mix(in_srgb,var(--error)_14%,transparent)] text-[var(--error)]',
    neutral: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
};

/** One summarised table cell (artboard 4d): never `[object Object]`. */
export default function SmartCell({ value, col }: { value: unknown; col: OutputColumn | null }) {
    const { t } = useTranslation();
    const s = summariseCell(value, col);
    switch (s.type) {
    case 'empty':
        return <span className="text-[var(--text-tertiary)]">—</span>;
    case 'status':
        return <span className={`inline-block px-[7px] rounded-full font-semibold whitespace-nowrap ${TONE_CLASS[s.tone]}`}>{s.text}</span>;
    case 'group':
        return (
            <span className="inline-flex items-center gap-[5px] px-2 py-0.5 rounded-md bg-[var(--bg-secondary)] max-w-full min-w-0" data-cell="group">
                <span className="truncate">{s.text || t('automations.output.cell_group', 'group')}</span>
                {s.more > 0 && <span className="text-[var(--text-tertiary)] shrink-0">+{s.more}</span>}
            </span>
        );
    case 'table':
        return (
            <span className="inline-flex items-center gap-[5px] px-2 py-0.5 rounded-md bg-[var(--bg-secondary)] whitespace-nowrap" data-cell="table">
                <Table size={12} aria-hidden />
                {s.count === 1
                    ? t('automations.output.cell_lines_one', '1 line')
                    : t('automations.output.cell_lines', '{count} lines', { count: s.count })}
            </span>
        );
    case 'list':
        return (
            <span className="inline-flex items-center gap-1 min-w-0" data-cell="list">
                {s.chips.map((c, i) => (
                    <span key={i} className="px-[7px] rounded-full border border-[var(--border-default)] truncate max-w-[120px]">{c}</span>
                ))}
                {s.more > 0 && <span className="text-[var(--text-tertiary)] shrink-0">+{s.more}</span>}
            </span>
        );
    default:
        return <span className={`block truncate ${s.align === 'right' ? 'text-right' : ''}`}>{s.text}</span>;
    }
}
