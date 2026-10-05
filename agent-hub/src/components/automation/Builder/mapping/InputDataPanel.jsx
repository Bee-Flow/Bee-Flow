import { Search, ArrowLeft, X, MousePointer2, MessageCircleQuestion } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { countInUse } from './boundPaths';
import { filterGroups } from './filterFields';
import InputNodeSection from './InputNodeSection';
import { FieldRow } from './VariableTree';
import { useTranslation } from '../../../../hooks/useTranslation';
import { walkPath } from '../../../../utils/bindingHelpers';
import { typeGroupOf } from '../flow/nodeTypeColors';
import OutputView from '../OutputView';

/**
 * The drawer's COMES IN column: the upstream data you map FROM (design
 * 2a/2b, reworked in round 4, artboards 4a/4b/4c).
 *
 * One bordered block per source step, nearest first (InputNodeSection):
 * at most six fields with a human name, a kind icon and a sample value from
 * the last run, the fields this step already uses on top, and the system
 * fields folded under "Technical details". The current LOOP ITEM, when there
 * is one, sits on top in the loop colour.
 *
 * Search is an icon that opens a field only when clicked (4c). `Per step |
 * All` flattens every field into one searchable list. The Table takeover
 * stays: it is the only view that maps a whole COLUMN or one cell (BFSF-329).
 *
 * Props:
 *   groups         useUpstreamVariables output, TOPOLOGICAL (trigger first,
 *                  nearest step last). Reordered on a COPY for display.
 *   previewSample  merged real/sample root, for the value column
 *   onPick(path)   insert this path into the focused setting
 *   stepTypeById   Map<stepId, type> for the family icon/colour (optional)
 *   stepNumberById Map<stepId, number> for "Step 9 ·" (optional)
 *   usedPaths      Set<path> the step already binds (mapping/boundPaths.js)
 *   loopIteration  { index, total } from the LAST RUN's loop row (artboard 2b)
 *   manualStart    the automation starts by hand: say that little comes in, and
 *                  offer onAddStartQuestion (open the start step) when given
 */
function familyOfGroup(group, stepTypeById) {
    if (!group) return null;
    if (group.kind === 'loop' || String(group.basePath || '').startsWith('loop.')) return 'loop';
    if (group.kind === 'trigger' || String(group.basePath || '').startsWith('trigger.')) return 'trigger';
    const type = stepTypeById?.get?.(group.id) || group.kind || null;
    return typeGroupOf(type);
}

export default function InputDataPanel({
    groups = [], previewSample = null, onPick,
    stepTypeById = null, stepNumberById = null, usedPaths = null,
    loopIteration = null, manualStart = false, onAddStartQuestion = null,
}) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [tableFor, setTableFor] = useState(null); // group id whose table took over
    const [view, setView] = useState('steps'); // 'steps' | 'all'

    // Nearest-first for display only; the current loop item first of all. The
    // "Trigger info" group is pushed LAST by the walk (it is not a step), so a
    // plain reverse would list it as the nearest source and open it by default
    // on top of the step that actually feeds this one: it goes at the bottom.
    const ordered = useMemo(() => {
        const copy = [...groups].reverse();
        const isItem = (g) => String(g?.basePath || '').startsWith('loop.');
        const isMeta = (g) => g?.kind === 'trigger_meta';
        return [
            ...copy.filter(isItem),
            ...copy.filter(g => !isItem(g) && !isMeta(g)),
            ...copy.filter(g => !isItem(g) && isMeta(g)),
        ];
    }, [groups]);
    // The step directly feeding this one: the nearest real source. It, the loop
    // item, and (only when the trigger itself is that source) "Trigger info"
    // start open.
    const nearestId = useMemo(
        () => ordered.find(g => !String(g?.basePath || '').startsWith('loop.') && g.kind !== 'trigger_meta')?.id ?? null,
        [ordered],
    );
    const nearestIsTrigger = useMemo(
        () => ordered.find(g => g.id === nearestId)?.kind === 'trigger',
        [ordered, nearestId],
    );
    // When that step has nothing to offer yet (it never ran), the nearest step
    // that DOES have fields opens too: otherwise the column opens on an empty
    // block and every value to drag is folded away.
    const fallbackOpenId = useMemo(() => {
        const nearest = ordered.find(g => g.id === nearestId);
        if (!nearest || (nearest.fields || []).length) return null;
        return ordered.find(g => g.id !== nearestId && !String(g?.basePath || '').startsWith('loop.')
            && g.kind !== 'trigger_meta' && (g.fields || []).length)?.id ?? null;
    }, [ordered, nearestId]);
    const shown = useMemo(() => filterGroups(ordered, query), [ordered, query]);

    const tableGroup = tableFor ? groups.find(g => g.id === tableFor) : null;

    if (!groups.length) {
        return (
            <div className="flex-1 px-4 py-6 text-xs text-[var(--text-tertiary)] italic">
                {t('automations.mapping.no_upstream', 'No upstream data yet. Connect this step to a previous one to see its output here.')}
            </div>
        );
    }

    if (tableGroup) {
        const value = walkPath(tableGroup.basePath, previewSample);
        return (
            <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--border-default)] shrink-0">
                    <button
                        type="button"
                        onClick={() => setTableFor(null)}
                        className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <ArrowLeft size={12} /> {t('automations.mapping.fields', 'Fields')}
                    </button>
                    <span className="ml-auto text-[11px] text-[var(--text-primary)] font-medium truncate">{tableGroup.label}</span>
                </div>
                <div className="flex-1 min-h-0 flex flex-col p-2">
                    <OutputView
                        value={value === undefined ? tableGroup.sample : value}
                        basePath={tableGroup.basePath}
                        fill
                        enableDrag
                        onPickPath={onPick}
                        emptyMessage={t('automations.mapping.no_data_yet', 'No data yet — run the upstream step to capture it.')}
                    />
                </div>
            </div>
        );
    }

    const seg = (on) => `px-2 py-[3px] rounded-md text-[11px] font-medium transition ${on ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;
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
                            placeholder={view === 'all' ? t('automations.mapping.search_all', 'Search in all steps…') : t('automations.mapping.search', 'Search a field…')}
                            aria-label={t('automations.mapping.search_fields', 'Search input fields')}
                            className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] focus:outline-none"
                        />
                        <button
                            type="button"
                            onClick={closeSearch}
                            aria-label={t('automations.mapping.clear_search', 'Clear search')}
                            className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        >
                            <X size={12} />
                        </button>
                    </>
                ) : <span className="flex-1" />}
                {groups.length > 1 && (
                    <div className="shrink-0 inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg-tertiary)]" role="group" aria-label={t('automations.mapping.view_group', 'Group fields')}>
                        <button type="button" onClick={() => setView('steps')} aria-pressed={view === 'steps'} className={seg(view === 'steps')}>{t('automations.mapping.per_step', 'Per step')}</button>
                        <button type="button" onClick={() => setView('all')} aria-pressed={view === 'all'} className={seg(view === 'all')}>{t('automations.mapping.all', 'All')}</button>
                    </div>
                )}
                {!searchOpen && <SearchToggle onOpen={() => setSearchOpen(true)} />}
            </div>
            <div className="relative flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 flex flex-col gap-2">
                {shown.length === 0 ? (
                    <div className="px-1 py-2 text-[11px] text-[var(--text-tertiary)] italic">{t('automations.mapping.no_matches', 'No matches.')}</div>
                ) : view === 'all' ? (
                    <div className="flex flex-col gap-0.5 shrink-0" data-testid="input-all-fields">
                        {shown.map(g => (
                            <React.Fragment key={g.id}>
                                <div className="px-2 pt-1 text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] truncate">{g.label}</div>
                                {(g.fields || []).map(f => (
                                    <FieldRow key={f.path} field={f} onInsert={onPick} depth={0} previewSample={previewSample} inUse={usedPaths} human />
                                ))}
                            </React.Fragment>
                        ))}
                    </div>
                ) : shown.map((g) => (
                    <InputNodeSection
                        key={g.id}
                        group={g}
                        family={familyOfGroup(g, stepTypeById)}
                        number={stepNumberById?.get?.(g.id) ?? null}
                        used={countInUse(g.fields, usedPaths)}
                        usedPaths={usedPaths}
                        previewSample={previewSample}
                        onPick={onPick}
                        iteration={String(g.basePath || '').startsWith('loop.') ? loopIteration : null}
                        // Only the nearest step (and the loop item, and the nearest
                        // one with fields when that step has none) start open; the
                        // rest are one click away. A search opens every match.
                        defaultOpen={!!query || g.id === nearestId || g.id === fallbackOpenId
                            || String(g.basePath || '').startsWith('loop.')
                            || (g.kind === 'trigger_meta' && nearestIsTrigger)}
                        searching={!!query}
                        onOpenTable={() => setTableFor(g.id)}
                    />
                ))}
                {manualStart && !query && <ManualStartHint onAdd={onAddStartQuestion} />}
                <div className="px-1 py-1 text-[11px] leading-4 text-[var(--text-tertiary)] flex gap-1.5 shrink-0">
                    <MousePointer2 size={13} className="shrink-0 mt-px" />
                    {t('automations.mapping.hint_drag', 'Drag a field onto a setting. Values come from the last run.')}
                </div>
            </div>
        </div>
    );
}

function SearchToggle({ onOpen }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={t('automations.mapping.search_open', 'Search fields')}
            title={t('automations.mapping.search_open', 'Search fields')}
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
function ManualStartHint({ onAdd }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-[10px] border border-dashed border-[var(--border-default)] px-3 py-2.5 text-[11px] leading-4 text-[var(--text-secondary)] flex flex-col gap-2 shrink-0" data-testid="input-manual-hint">
            <span>{t('automations.mapping.manual_start_hint', "A manual start passes little, that's normal. Want to ask something when it starts, like a folder?")}</span>
            {onAdd && (
                <button
                    type="button"
                    onClick={onAdd}
                    className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                    <MessageCircleQuestion size={13} /> {t('automations.mapping.add_start_question', 'Add a question to the start')}
                </button>
            )}
        </div>
    );
}
