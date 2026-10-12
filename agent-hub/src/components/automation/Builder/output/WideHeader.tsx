import { ChevronLeft, Columns3, Minimize2, Rows3, Search } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import ColumnPicker from './ColumnPicker';
import Crumbs from './Crumbs';
import type { Crumb } from './levels';
import { rowsAndColumns } from './NestedTable';
import type { OutputColumnsState } from './useOutputColumns';

// Never wraps: "Columns · 2 of 2" stays one line in a narrow header.
const TOOL_BTN = 'px-2.5 py-[5px] rounded-lg border flex items-center gap-1.5 whitespace-nowrap shrink-0';

interface WideHeaderProps {
    crumbs: Crumb[];
    onCrumb: (target: number) => void;
    /** Up one level; null at the top, where the "3" badge shows instead. */
    onBack: (() => void) | null;
    /** Rows of the level on screen. */
    rowCount: number;
    cols: OutputColumnsState;
    shownCount: number;
    query: string;
    onQuery: (q: string) => void;
    pickerOpen: boolean;
    onTogglePicker: () => void;
    compact: boolean;
    onToggleCompact: () => void;
    json: boolean;
    onJson: (json: boolean) => void;
    onClose: () => void;
}

/**
 * The large view's 52px toolbar (artboard 4d): where you are, what this level
 * holds, and the tools that work on it.
 */
export default function WideHeader({
    crumbs, onCrumb, onBack, rowCount, cols, shownCount, query, onQuery, pickerOpen, onTogglePicker,
    compact, onToggleCompact, json, onJson, onClose,
}: WideHeaderProps) {
    const { t } = useTranslation();
    const seg = (on: boolean) => `px-2 py-[3px] rounded-md ${on ? 'bg-[var(--bg-card)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;
    return (
        <div className="h-[52px] shrink-0 flex items-center gap-2.5 px-4 border-b border-[var(--border-default)]">
            {onBack ? (
                <button
                    type="button"
                    onClick={onBack}
                    aria-label={t('common.back', 'Back')}
                    title={crumbs.length > 1 ? crumbs[crumbs.length - 2].text : undefined}
                    className="w-[22px] h-[22px] rounded-full bg-[var(--bg-tertiary)] grid place-items-center shrink-0 hover:bg-[var(--bg-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--type-ai)]"
                >
                    <ChevronLeft size={14} aria-hidden />
                </button>
            ) : (
                // Column 3 of the drawer, enlarged: the same numbered heading.
                <div className="w-[22px] h-[22px] rounded-full bg-[var(--bg-tertiary)] font-bold grid place-items-center shrink-0" aria-hidden>3</div>
            )}
            <div className="min-w-0">
                <Crumbs crumbs={crumbs} onCrumb={onCrumb} />
                <div className="text-[var(--text-secondary)] truncate @max-[900px]/wideout:hidden">
                    {`${json ? t('automations.output.mode_json', 'JSON') : t('automations.output.mode_table', 'Table')} · ${rowsAndColumns(t, rowCount, cols.columns.length)}`}
                </div>
            </div>
            {/* JSON mode has its own search (keys and values) inside the tree. */}
            {!json && <RowSearch query={query} onQuery={onQuery} />}
            {!json && (
                <div className="relative shrink-0">
                    <button
                        type="button"
                        aria-expanded={pickerOpen}
                        onClick={onTogglePicker}
                        className={`${TOOL_BTN} font-semibold ${pickerOpen ? 'border-[1.5px] border-[var(--text-primary)]' : 'border-[var(--border-default)]'}`}
                    >
                        <Columns3 size={13} aria-hidden />
                        {/* Icon only below 760px, like Compact: the trail needs the room. */}
                        <span className="@max-[760px]/wideout:sr-only">{t('automations.output.columns_n_of', 'Columns · {shown} of {total}', { shown: shownCount, total: cols.columns.length })}</span>
                    </button>
                    {pickerOpen && <ColumnPicker cols={cols} shown={cols.wide} />}
                </div>
            )}
            {!json && (
                <button type="button" aria-pressed={compact} onClick={onToggleCompact} className={`${TOOL_BTN} ${compact ? 'border-[var(--text-primary)] text-[var(--text-primary)]' : 'border-[var(--border-default)] text-[var(--text-secondary)]'}`}>
                    <Rows3 size={13} aria-hidden /><span className="@max-[760px]/wideout:sr-only">{t('automations.output.compact', 'Compact')}</span>
                </button>
            )}
            <div className="flex-1" />
            <div className="flex bg-[var(--bg-tertiary)] rounded-lg p-0.5 gap-0.5 font-medium">
                <button type="button" aria-pressed={!json} onClick={() => onJson(false)} className={seg(!json)}>{t('automations.output.mode_table', 'Table')}</button>
                <button type="button" aria-pressed={json} onClick={() => onJson(true)} className={seg(json)}>{t('automations.output.mode_json', 'JSON')}</button>
            </div>
            <button type="button" onClick={onClose} aria-label={t('automations.output.collapse', 'Back to the drawer')} className="w-[30px] h-[30px] rounded-lg grid place-items-center text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]">
                <Minimize2 size={15} />
            </button>
        </div>
    );
}

/** "Search rows…": filters the level's rows on any value in them. */
function RowSearch({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
    const { t } = useTranslation();
    return (
        <label className="flex items-center gap-1.5 ml-4 px-2.5 py-[5px] rounded-lg border border-[var(--border-default)] w-[200px] @max-[760px]/wideout:w-[130px] @max-[760px]/wideout:ml-0 text-[var(--text-tertiary)]">
            <Search size={13} aria-hidden />
            <input
                type="search"
                data-wide-search
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder={t('automations.output.search_rows', 'Search rows…')}
                aria-label={t('automations.output.search_rows', 'Search rows…')}
                className="flex-1 min-w-0 bg-transparent outline-none text-[var(--text-primary)]"
            />
        </label>
    );
}
