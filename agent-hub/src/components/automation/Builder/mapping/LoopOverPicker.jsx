import { sourceFromPath, walkPath } from '@shared/mapping/index.mjs';
import { Repeat, ChevronRight, ChevronDown, Check } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { collectArrayPaths, suggestItemVar } from './upstream';
import { useVariablePickerContext } from './VariablePickerContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import { previewValue } from '../../../../utils/bindingHelpers';
import { listLabel } from '../flow/settings/advanced/stepRepeat';
import { listPathLabel } from '../valueSlot/usePickLabel';
import { denseInputClass } from '../flow/settings/formStyles';

/**
 * Picker for a Loop step's list, and for the older per-item setting of a
 * step (`forEach.overRef`). Surfaces the upstream lists as choices in the
 * author's words ("Results from Search web", the same words the step header
 * and the repeat setting use) instead of raw `steps.<id>.output…` paths. The
 * path itself, read and counted by the shared mapping core exactly as the run
 * reads it, stays editable under "Formula" for power users.
 *
 * Renaming the item (typed, or suggested by a newly picked list) only emits
 * the new name; the caller rewrites the values that read the old one
 * (stepRepeat.ts → renameItemVar), so a rename never strands them.
 *
 * Props:
 *   overRef, itemVar, onChange({overRef,itemVar}), groups, onFocusField
 */
export default function LoopOverPicker({
    overRef = '',
    itemVar = 'item',
    onChange,
    groups = [],
    onFocusField,
}) {
    const { stepLabelById, previewSample } = useVariablePickerContext();
    const { t } = useTranslation();
    // Same source as CollectionArrayRefField's quick-picks: group fields
    // (incl. `[*]` children) PLUS arrays present only in real-run/pinned
    // output — so "Lists you can repeat over" and the source-list picker
    // never disagree about which lists exist.
    const arrayFields = useMemo(() => collectArrayPaths(groups, previewSample), [groups, previewSample]);
    const [advanced, setAdvanced] = useState(false);

    const pick = (path, suggestedVar) => {
        const nextItem = (!itemVar || itemVar === 'item') ? (suggestedVar || 'item') : itemVar;
        onChange?.({ overRef: path, itemVar: nextItem });
    };
    const onTypedPath = (e) => onChange?.({ overRef: e.target.value, itemVar });
    const onTypedVar = (e) => onChange?.({ overRef, itemVar: e.target.value.replace(/[^A-Za-z0-9_]/g, '') || 'item' });

    const label = (path) => listLabel(sourceFromPath(path), stepLabelById, t);
    const friendlyOver = overRef ? label(overRef) : '';

    return (
        <div className="space-y-3">
            <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-[var(--text-secondary)]">{t('mapping.repeat.for_each_in', 'Run for each item in…')}</label>

                {overRef && (
                    <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/5 text-xs">
                        <Repeat size={12} className="shrink-0 text-[var(--accent)]" />
                        <span className="truncate text-[var(--text-primary)]">{friendlyOver}</span>
                    </div>
                )}

                {arrayFields.length > 0 ? (
                    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/40 divide-y divide-[var(--border-default)]">
                        <div className="px-2 py-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]">
                            {t('mapping.repeat.lists_heading', 'Lists you can repeat over')}
                        </div>
                        {arrayFields.map(f => {
                            const selected = overRef === f.path;
                            // Column paths read as "Field of all rows" (M4b);
                            // counts resolve through the run's own walkPath —
                            // a [*] path's f.sample is the first ELEMENT, so
                            // its length was the first row's size, not the list's.
                            const friendly = f.path.includes('[*]')
                                ? listPathLabel(t, f.path, stepLabelById)
                                : label(f.path);
                            const resolved = previewSample ? walkPath(f.path, previewSample) : undefined;
                            const preview = Array.isArray(resolved)
                                ? t('mapping.repeat.n_items', '{count} items', { count: resolved.length })
                                : previewValue(resolved !== undefined ? resolved : f.sample, 24);
                            return (
                                <button
                                    key={f.path}
                                    type="button"
                                    onClick={() => pick(f.path, suggestItemVar(f.key))}
                                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-secondary)] ${selected ? 'bg-[var(--bg-secondary)]' : ''}`}
                                >
                                    <Repeat size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                                    <span className="text-[var(--text-primary)] truncate">{friendly}</span>
                                    <span className="ml-auto text-[10px] text-[var(--text-tertiary)] truncate max-w-[120px]">{preview}</span>
                                    {selected && <Check size={12} className="shrink-0 text-[var(--accent)]" />}
                                </button>
                            );
                        })}
                    </div>
                ) : (
                    <div className="text-[10px] text-[var(--text-tertiary)] italic">
                        {t('mapping.repeat.no_lists_formula', 'No earlier list found. Enter one under Formula.')}
                    </div>
                )}
            </div>

            <div className="space-y-1">
                <label className="text-[11px] font-medium text-[var(--text-secondary)]">{t('mapping.repeat.item_name', 'Name each item')}</label>
                <input
                    type="text"
                    value={itemVar || 'item'}
                    onChange={onTypedVar}
                    placeholder="item"
                    aria-label={t('mapping.repeat.item_name', 'Name each item')}
                    className={denseInputClass('w-full')}
                />
                {/* Words, not the binding syntax: the values that read the
                    item show it by this name, and a rename carries them along. */}
                <div className="text-[10px] text-[var(--text-tertiary)]">
                    {t('mapping.repeat.item_name_hint', 'What each item is called in the values that read it. Renaming it updates them.')}
                </div>
            </div>

            <button
                type="button"
                onClick={() => setAdvanced(a => !a)}
                className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            >
                {advanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {t('mapping.repeat.formula', 'Formula')}
            </button>
            {advanced && (
                <div className="space-y-1">
                    <label className="text-[10px] text-[var(--text-tertiary)]">{t('mapping.repeat.formula_list', 'The list, as a formula')}</label>
                    <input
                        type="text"
                        value={overRef}
                        onChange={onTypedPath}
                        onFocus={() => onFocusField?.({ id: 'overRef', label: t('mapping.repeat.formula_list', 'The list, as a formula'), insert: (path) => onChange?.({ overRef: path, itemVar }) })}
                        placeholder="steps.s1.output.results"
                        className={denseInputClass('w-full font-mono')}
                    />
                </div>
            )}
        </div>
    );
}

