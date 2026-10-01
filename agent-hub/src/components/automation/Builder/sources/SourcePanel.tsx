import { Search, X, MousePointer2, MessageCircleQuestion } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import SourceNode from './SourceNode';
import TableTakeover from './TableTakeover';
import { isLoopItemGroup, useSourceTree, withItemTitles, type TreeGroup } from './useSourceTree';
import { useTranslation } from '../../../../hooks/useTranslation';
import { typeGroupOf } from '../flow/nodeTypeColors';
import { countInUse } from '../mapping/boundPaths';
import InputNodeSection from '../mapping/InputNodeSection';
import type { PickOpts } from '../output/mapAttrs';

/**
 * The drawer's COMES IN column: the upstream data you map FROM (design
 * 2a/2b, reworked in round 4, artboards 4a/4b/4c).
 *
 * One bordered block per source step, nearest first (InputNodeSection): at
 * most six values with a human name, a kind icon and a sample value from the
 * last run, the values this step already uses on top, and the system fields
 * folded under "Technical details". The CURRENT ITEM, when there is one,
 * sits on top in the loop colour: a loop's item, or the item of a step that
 * runs once per item ("Current order line", named after its list). A value
 * of the latter goes into a field as a pick of that one item (`take: 'each'`). Each value is a SourceNode: nested
 * data opens like folders, a list opens to its columns, a key the last run
 * lacked is dimmed.
 *
 * Search is an icon that opens a field only when clicked (4c). `Per step |
 * All` flattens every field into one searchable list. The Table takeover
 * stays: it is the only view that maps a whole COLUMN or one cell (BFSF-329).
 *
 * Props:
 *   groups         useUpstreamVariables output, TOPOLOGICAL (trigger first,
 *                  nearest step last). Reordered on a COPY for display.
 *   previewSample  merged real/sample root, for the value column
 *   onPick(path, opts)  insert this value into the focused setting; `opts`
 *                  carries `raw` (Alt held) and the value's Source
 *   stepTypeById   Map<stepId, type> for the family icon/colour (optional)
 *   stepNumberById Map<stepId, number> for "Step 9 ·" (optional)
 *   usedPaths      Set<path> the step already binds (mapping/boundPaths.js)
 *   loopIteration  { index, total } from the LAST RUN's loop row (artboard 2b)
 *   manualStart    the routine starts by hand: say that little comes in, and
 *                  offer onAddStartQuestion (open the start step) when given
 */
export interface SourcePanelProps {
    groups?: TreeGroup[];
    previewSample?: unknown;
    onPick: (path: string, opts?: PickOpts) => void;
    stepTypeById?: Map<string, string> | null;
    stepNumberById?: Map<string, number> | null;
    usedPaths?: Set<string> | null;
    loopIteration?: { index: number; total: number; truncated?: boolean; skipped?: number } | null;
    manualStart?: boolean;
    onAddStartQuestion?: (() => void) | null;
}

const familyOf = typeGroupOf as (type: unknown) => string | null;
const countUsed = countInUse as (fields: unknown, used: Set<string> | null) => number;

function familyOfGroup(group: TreeGroup, stepTypeById: Map<string, string> | null): string | null {
    if (group.kind === 'loop' || isLoopItemGroup(group)) return 'loop';
    if (group.kind === 'trigger' || String(group.basePath || '').startsWith('trigger.')) return 'trigger';
    return familyOf(stepTypeById?.get?.(group.id) || group.kind || null);
}

export default function SourcePanel({
    groups: given = [], previewSample = null, onPick,
    stepTypeById = null, stepNumberById = null, usedPaths = null,
    loopIteration = null, manualStart = false, onAddStartQuestion = null,
}: SourcePanelProps) {
    const { t } = useTranslation();
    const groups = useMemo(() => withItemTitles(given, t), [given, t]);
    const [query, setQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [tableFor, setTableFor] = useState<string | null>(null); // group id whose table took over
    const [view, setView] = useState<'steps' | 'all'>('steps');
    const { shown } = useSourceTree(groups, query);

    const tableGroup = tableFor ? groups.find(g => g.id === tableFor) : null;

    if (!groups.length) {
        return (
            <div className="flex-1 px-4 py-6 text-xs text-[var(--text-tertiary)] italic">
                {t('routines.mapping.no_upstream', 'No upstream data yet. Connect this step to a previous one to see its output here.')}
            </div>
        );
    }

    if (tableGroup) {
        return <TableTakeover group={tableGroup} previewSample={previewSample} onPick={onPick} onBack={() => setTableFor(null)} />;
    }

    const seg = (on: boolean) => `px-2 py-[3px] rounded-md text-[11px] font-medium transition ${on ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;
    const closeSearch = () => { setQuery(''); setSearchOpen(false); };

    return (
        <div className="flex-1 min-h-0 flex flex-col">
            {/* Always a row, also for one step: the search used to float over
                the first card's corner there, on top of its field count. */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border-default)] shrink-0 min-h-[34px]">
                {searchOpen ? (
                    <>
                        <Search size={12} className="text-[var(--text-tertiary)] shrink-0" />
                        <input
                            type="text"
                            value={query}
                            autoFocus
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); } }}
                            placeholder={view === 'all' ? t('routines.mapping.search_all', 'Search in all steps…') : t('routines.mapping.search', 'Search a field…')}
                            aria-label={t('routines.mapping.search_fields', 'Search input fields')}
                            className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] focus:outline-none"
                        />
                        <button
                            type="button"
                            onClick={closeSearch}
                            aria-label={t('routines.mapping.clear_search', 'Clear search')}
                            className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        >
                            <X size={12} />
                        </button>
                    </>
                ) : <span className="flex-1" />}
                {groups.length > 1 && (
                    <div className="shrink-0 inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg-tertiary)]" role="group" aria-label={t('routines.mapping.view_group', 'Group fields')}>
                        <button type="button" onClick={() => setView('steps')} aria-pressed={view === 'steps'} className={seg(view === 'steps')}>{t('routines.mapping.per_step', 'Per step')}</button>
                        <button type="button" onClick={() => setView('all')} aria-pressed={view === 'all'} className={seg(view === 'all')}>{t('routines.mapping.all', 'All')}</button>
                    </div>
                )}
                {!searchOpen && <SearchToggle onOpen={() => setSearchOpen(true)} />}
            </div>
            <div className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 flex flex-col gap-2">
                {shown.length === 0 ? (
                    <div className="px-1 py-2 text-[11px] text-[var(--text-tertiary)] italic">{t('routines.mapping.no_matches', 'No matches.')}</div>
                ) : view === 'all' ? (
                    <div className="flex flex-col gap-0.5 shrink-0" data-testid="input-all-fields">
                        {shown.map(g => (
                            <Fragment key={g.id}>
                                <div className="px-2 pt-1 text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] truncate">{g.label}</div>
                                {(g.fields || []).map(f => (
                                    <SourceNode key={f.path || f.key} node={f} onInsert={onPick} depth={0} previewSample={previewSample} usedPaths={usedPaths} human />
                                ))}
                            </Fragment>
                        ))}
                    </div>
                ) : shown.map((g, i) => (
                    <InputNodeSection
                        key={g.id}
                        group={g}
                        family={familyOfGroup(g, stepTypeById)}
                        number={stepNumberById?.get?.(g.id) ?? null}
                        used={countUsed(g.fields, usedPaths)}
                        usedPaths={usedPaths}
                        previewSample={previewSample}
                        onPick={onPick}
                        iteration={isLoopItemGroup(g) ? loopIteration : null}
                        // Only the nearest step (and the loop item) start open;
                        // the rest are one click away. A search opens every match.
                        defaultOpen={!!query || i === 0 || isLoopItemGroup(g)}
                        searching={!!query}
                        onOpenTable={() => setTableFor(g.id)}
                    />
                ))}
                {manualStart && !query && <ManualStartHint onAdd={onAddStartQuestion} />}
                <div className="px-1 py-1 text-[11px] leading-4 text-[var(--text-tertiary)] flex gap-1.5 shrink-0">
                    <MousePointer2 size={13} className="shrink-0 mt-px" />
                    {t('routines.mapping.hint_drag', 'Drag a field onto a setting. Values come from the last run.')}
                </div>
            </div>
        </div>
    );
}

function SearchToggle({ onOpen }: { onOpen: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={t('routines.mapping.search_open', 'Search fields')}
            title={t('routines.mapping.search_open', 'Search fields')}
            className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            data-testid="input-search-toggle"
        >
            <Search size={15} />
        </button>
    );
}

/**
 * Artboard 4b: a manual start passes little, and that is normal. Said once,
 * with the way to ask for something at the start (open the start step,
 * where a question turns it into a form).
 */
function ManualStartHint({ onAdd }: { onAdd: (() => void) | null }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-[10px] border border-dashed border-[var(--border-default)] px-3 py-2.5 text-[11px] leading-4 text-[var(--text-secondary)] flex flex-col gap-2 shrink-0" data-testid="input-manual-hint">
            <span>{t('routines.mapping.manual_start_hint', "A manual start passes little, that's normal. Want to ask something when it starts, like a folder?")}</span>
            {onAdd && (
                <button
                    type="button"
                    onClick={onAdd}
                    className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                    <MessageCircleQuestion size={13} /> {t('routines.mapping.add_start_question', 'Add a question to the start')}
                </button>
            )}
        </div>
    );
}
