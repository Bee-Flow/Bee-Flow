import { getPath } from '@shared/expr/path.mjs';
import { Repeat, ChevronRight, ChevronDown, Check } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { listPathLabel } from './listPathLabel';
import { loopListChoices, pickLoopList } from './loopLists';
import { useVariablePickerContext } from './VariablePickerContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import { previewValue } from '../../../../utils/bindingHelpers';
import { AMBER_NOTE, INLINE_LINK, denseInputClass } from '../flow/settings/formStyles';

/** What the last pick changed, with Undo. */
function ListChangeNote({ note, onUndo, t }) {
    return (
        <div role="status" className={`${AMBER_NOTE} text-[11px] space-y-0.5`}>
            <div>{t('automations.builder.list_changed_runs', 'Now runs once per {item}.', { item: note.item })}</div>
            {note.kept && <div>{t('automations.builder.list_changed_kept', 'Fields that read each {item} keep reading it.', { item: note.kept })}</div>}
            {note.moved.length > 0 && <div>{t('automations.builder.list_changed_moved', 'Now reading the new item: {fields}.', { fields: note.moved.join(', ') })}</div>}
            {note.orphans.length > 0 && <div>{t('automations.builder.list_changed_orphans', 'The new item has nothing for {fields} — pick them again.', { fields: note.orphans.join(', ') })}</div>}
            <button type="button" onClick={onUndo} className={INLINE_LINK}>{t('automations.builder.undo', 'Undo')}</button>
        </div>
    );
}

/** One list to repeat over: its name in words, how many items it holds. */
function ListChoice({ choice, selected, onPick, previewSample, stepLabelById, stepTypeById, t }) {
    // Counts resolve through the runtime's walker — a [*] path's sample is the
    // first ELEMENT, so its length was the first row's size, not the list's.
    const resolved = previewSample ? getPath(previewSample, choice.path) : undefined;
    const preview = Array.isArray(resolved)
        ? (resolved.length === 1 ? t('automations.builder.one_item', '1 item') : t('automations.builder.n_items', '{n} items', { n: resolved.length }))
        : previewValue(resolved !== undefined ? resolved : choice.sample, 24);
    return (
        <button
            type="button"
            onClick={() => onPick(choice.path, choice.sample)}
            title={choice.path}
            className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-secondary)] ${selected ? 'bg-[var(--bg-secondary)]' : ''}`}
        >
            <Repeat size={12} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="text-[var(--text-primary)] truncate">{listPathLabel(choice.path, stepLabelById, t, { stepTypeById })}</span>
            <span className="ml-auto text-[10px] text-[var(--text-tertiary)] truncate max-w-[120px]">{preview}</span>
            {selected && <Check size={12} className="shrink-0 text-[var(--accent)]" />}
        </button>
    );
}

/**
 * Picker for a Loop / forEach step's `overRef`. Surfaces the upstream
 * ARRAY fields as friendly choices (step name → field) instead of raw
 * `steps.<id>.output…` paths, so non-technical users can pick what to
 * iterate. The raw path stays editable under "Advanced" for power users.
 *
 * Picking another list re-points the step (deepenForEach.rebaseForEach): a
 * list inside the current one keeps the current item as an outer item, so
 * every field keeps reading what it read; any other list names the item after
 * it and moves each field to the same-named field of the new item, and says
 * which fields have no counterpart, with Undo. That needs the step's fields:
 * `bindings` (a step's inputs, or a Loop's body) and `onRebind(next)`.
 *
 * Props:
 *   overRef, itemVar, parents, onChange({overRef,itemVar,parents}), groups,
 *   onFocusField, bindings, onRebind, container (a Loop: its body follows the item
 *   by name, plain strings too, and it keeps no outer items)
 */
/** Picking a list, its note and its Undo (the fields follow when they are given). */
function useListPick({ overRef, itemVar, parents, bindings, onRebind, container, onChange, previewSample, definition }) {
    // What the last pick changed, for its note and Undo.
    const [note, setNote] = useState(null);
    const canRebind = !!onRebind && bindings !== undefined;
    const pick = (path, sample) => {
        const r = pickLoopList({ overRef, itemVar, parents }, { path, sample }, { previewSample, bindings: canRebind ? bindings : undefined, container, definition });
        onChange?.(r.patch);
        if (r.bindings !== undefined) onRebind(r.bindings);
        setNote(r.note ? { ...r.note, undo: { overRef, itemVar, parents, bindings } } : null);
    };
    const undo = () => {
        const u = note?.undo;
        setNote(null);
        if (!u) return;
        onChange?.({ overRef: u.overRef, itemVar: u.itemVar, parents: u.parents });
        if (canRebind) onRebind(u.bindings);
    };
    return { note, pick, undo };
}

export default function LoopOverPicker({
    overRef = '',
    itemVar = 'item',
    parents,
    onChange,
    groups = [],
    onFocusField,
    bindings,
    onRebind = null,
    container = false,
}) {
    const { stepLabelById, stepTypeById, previewSample, definition } = useVariablePickerContext();
    const { t } = useTranslation();
    const arrayFields = useMemo(() => loopListChoices(groups, previewSample), [groups, previewSample]);
    const [advanced, setAdvanced] = useState(false);
    const { note, pick, undo } = useListPick({ overRef, itemVar, parents, bindings, onRebind, container, onChange, previewSample, definition });
    const onTypedPath = (e) => onChange?.({ overRef: e.target.value, itemVar });
    const onTypedVar = (e) => onChange?.({ overRef, itemVar: e.target.value.replace(/[^A-Za-z0-9_]/g, '') || 'item' });

    // The chosen list reads like the choices below it, never as a path.
    const friendlyOver = overRef ? listPathLabel(overRef, stepLabelById, t, { stepTypeById }) : '';

    return (
        <div className="space-y-3">
            <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-[var(--text-secondary)]">{t('automations.builder.run_for_each', 'Run this step for each…')}</label>

                {overRef && (
                    <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/5 text-xs">
                        <Repeat size={12} className="shrink-0 text-[var(--accent)]" />
                        <span className="truncate text-[var(--text-primary)]" title={overRef}>{friendlyOver || t('automations.builder.item_word', 'item')}</span>
                    </div>
                )}

                {note && <ListChangeNote note={note} onUndo={undo} t={t} />}

                {arrayFields.length > 0 ? (
                    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/40 divide-y divide-[var(--border-default)]">
                        <div className="px-2 py-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]">
                            {t('automations.builder.lists_to_repeat_over', 'Lists you can repeat over')}
                        </div>
                        {arrayFields.map(f => (
                            <ListChoice key={f.path} choice={f} selected={overRef === f.path} onPick={pick} previewSample={previewSample} stepLabelById={stepLabelById} stepTypeById={stepTypeById} t={t} />
                        ))}
                    </div>
                ) : (
                    <div className="text-[10px] text-[var(--text-tertiary)] italic">
                        {t('automations.builder.no_upstream_lists', 'No upstream lists detected — open Advanced to enter one by hand.')}
                    </div>
                )}
            </div>

            <div className="space-y-1">
                <label className="text-[11px] font-medium text-[var(--text-secondary)]">{t('automations.builder.name_each_item', 'Name each item')}</label>
                <input
                    type="text"
                    value={itemVar || 'item'}
                    onChange={onTypedVar}
                    placeholder={t('automations.loop_over_picker.item', 'item')}
                    className={denseInputClass('w-full')}
                />
                {/* `loop.` is not decoration — it is the binding. This line
                    used to say the item arrives as plain `item`, so anyone who
                    followed it wrote `item.x` in a body step and got nothing
                    back, silently. The canvas node and the loop settings panel
                    both said `loop.item` correctly; only the picker, the one
                    place you are actually naming the thing, did not. */}
                <div className="text-[10px] text-[var(--text-tertiary)]">
                    {t('automations.builder.each_item_available_as', 'Each item is available to the steps below as')} <span className="font-medium font-mono">loop.{itemVar || 'item'}</span>.
                </div>
            </div>

            <button
                type="button"
                onClick={() => setAdvanced(a => !a)}
                className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            >
                {advanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {t('automations.builder.advanced', 'Advanced')}
            </button>
            {advanced && (
                <div className="space-y-1">
                    <label className="text-[10px] text-[var(--text-tertiary)]">{t('automations.builder.list_path_expression', 'List path (expression)')}</label>
                    <input
                        type="text"
                        value={overRef}
                        onChange={onTypedPath}
                        onFocus={() => onFocusField?.({ id: 'overRef', label: 'iterate over', insert: (path) => onChange?.({ overRef: path, itemVar }) })}
                        placeholder="steps.s1.output.results"
                        className={denseInputClass('w-full font-mono')}
                    />
                </div>
            )}
        </div>
    );
}
