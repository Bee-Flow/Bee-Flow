import { useState } from 'react';
import { ChevronDown, ChevronRight, Pin, Search, Square, SquareCheck } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { OutputColumn } from './columns';
import type { OutputColumnsState } from './useOutputColumns';

interface ColumnPickerProps {
    cols: OutputColumnsState;
    /** The keys on screen now, in order. */
    shown: string[];
}

const SECTION = 'px-3 pt-2 pb-1 text-[10px] tracking-[.06em] uppercase font-semibold text-[var(--text-tertiary)] flex';
const FOOT_BTN = 'px-2.5 py-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-[var(--bg-tertiary)]';

/**
 * "Columns · 7 of 16" (artboard 4d): shown, hidden and technical columns, a
 * group split into one column per field, Show all and Back to suggestion.
 * Every choice is remembered for this step.
 */
export default function ColumnPicker({ cols, shown }: ColumnPickerProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [techOpen, setTechOpen] = useState(false);
    const q = query.trim().toLowerCase();
    const matches = (c: OutputColumn) => !q || c.label.toLowerCase().includes(q) || c.key.toLowerCase().includes(q);
    const byKey = new Map(cols.columns.map(c => [c.key, c]));
    const shownCols = shown.map(k => byKey.get(k)).filter((c): c is OutputColumn => !!c && matches(c));
    const hidden = cols.columns.filter(c => !c.technical && !shown.includes(c.key) && matches(c));
    const technical = cols.columns.filter(c => c.technical && !shown.includes(c.key) && matches(c));

    const row = (c: OutputColumn, on: boolean, i: number) => <PickerRow key={c.key} col={c} on={on} pinned={on && i === 0} cols={cols} shown={shown} />;

    const techNames = cols.columns.filter(c => c.technical).slice(0, 4).map(c => c.key).join(', ');
    return (
        <div
            role="dialog"
            aria-label={t('automations.output.columns_dialog', 'Choose columns')}
            className="absolute left-0 top-full mt-1 w-[300px] max-h-[420px] rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-2xl z-30 flex flex-col overflow-hidden text-xs"
        >
            <label className="flex items-center gap-1.5 px-3 py-2.5 border-b border-[var(--border-default)] text-[var(--text-tertiary)]">
                <Search size={13} aria-hidden />
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('automations.output.find_column', 'Find a column…')}
                    aria-label={t('automations.output.find_column', 'Find a column…')}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[var(--text-primary)]"
                />
            </label>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pb-1">
                <div className={SECTION}>{t('automations.output.cols_shown', 'Shown')}</div>
                {shownCols.map((c, i) => row(c, true, i))}
                {hidden.length > 0 && (
                    <>
                        <div className={`${SECTION} border-t border-[var(--border-default)] mt-1`}>{t('automations.output.cols_hidden', 'Hidden')}</div>
                        {hidden.map((c) => row(c, false, -1))}
                    </>
                )}
                {technical.length > 0 && (
                    <>
                        <button
                            type="button"
                            aria-expanded={techOpen}
                            onClick={() => setTechOpen(v => !v)}
                            className="w-full flex items-center gap-2 px-3 py-2 border-t border-[var(--border-default)] mt-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        >
                            {techOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                            {t('automations.output.cols_technical', 'Technical · {count} ({names})', { count: technical.length, names: techNames })}
                        </button>
                        {techOpen && technical.map((c) => row(c, false, -1))}
                    </>
                )}
            </div>
            <div className="flex gap-1.5 px-3 py-2 border-t border-[var(--border-default)] bg-[var(--bg-secondary)]">
                <button type="button" onClick={cols.showAll} className={FOOT_BTN}>{t('automations.output.show_all', 'Show all')}</button>
                <button type="button" onClick={cols.reset} className={FOOT_BTN} disabled={!cols.customised && cols.split.length === 0}>
                    {t('automations.output.back_to_suggestion', 'Back to suggestion')}
                </button>
            </div>
        </div>
    );
}

interface PickerRowProps { col: OutputColumn; on: boolean; pinned: boolean; cols: OutputColumnsState; shown: string[] }

/** One column in the picker: its checkbox, and split / keep together for a group. */
function PickerRow({ col: c, on, pinned, cols, shown }: PickerRowProps) {
    const { t } = useTranslation();
    const Box = on ? SquareCheck : Square;
    const firstOfSplit = c.parent && shown.find(k => k.startsWith(`${c.parent}.`)) === c.key;
    return (
        <div className={`flex items-center gap-2 px-3 py-[5px] ${on ? '' : 'text-[var(--text-secondary)]'}`}>
            <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => cols.toggle(c.key, shown)}
                className="inline-flex items-center gap-2 min-w-0 text-left"
            >
                <Box size={14} className="shrink-0" aria-hidden />
                <span className="truncate">{c.label}</span>
            </button>
            {c.kind === 'group' && c.groupSize != null && (
                <span className="text-[var(--text-tertiary)] shrink-0">{t('automations.output.group_n', 'group · {count}', { count: c.groupSize })}</span>
            )}
            {pinned && <Pin size={12} className="ml-auto shrink-0 text-[var(--text-tertiary)]" aria-label={t('automations.output.pinned', 'Pinned on the left')} />}
            {c.kind === 'group' && !c.parent && (
                <button type="button" onClick={() => cols.splitGroup(c.key, shown)} className="ml-auto shrink-0 font-semibold text-[var(--type-ai)] hover:underline">
                    {t('automations.output.split', 'split')}
                </button>
            )}
            {firstOfSplit && c.parent && (
                <button type="button" onClick={() => cols.joinGroup(c.parent as string, shown)} className="ml-auto shrink-0 font-semibold text-[var(--type-ai)] hover:underline">
                    {t('automations.output.join', 'keep together')}
                </button>
            )}
        </div>
    );
}
