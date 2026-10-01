// "Repeat › Run this step separately for each…": the one place in the web
// editor where a step is set to run once per item of a list, and where an
// older per-item setting (step.forEach) is edited or switched off. Picking a
// value never does either on the side; the step header says it in one
// sentence while it is on (valueSlot/RepeatNotice.tsx).
//
// Turning it on shows what it does before it is done: how many values will
// read the current item, or that none does yet (the step would then do the
// same thing for every item). The rewriting is the shared core's
// (stepRepeat.ts → repeat.mjs).

import { manyItems, walkSource } from '@shared/mapping/index.mjs';
import type { MappingSource } from '@shared/mapping/index.mjs';
import { Check, Repeat } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
    forEachOf, legacySource, listLabel, repeatOf, planForEachChange, planForEachOff, planRepeat, planRepeatOff, planRepeatSwitch,
    renameRefusal, repeatChoices, repeatCount, repeatRefusal,
} from './stepRepeat';
import type { Draft, LegacyForEach, Patch, RepeatChoice } from './stepRepeat';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import LoopOverPicker from '../../../mapping/LoopOverPicker';
import { useVariablePickerContext } from '../../../mapping/VariablePickerContext';
import { AMBER_NOTE, FormRow, inputClass } from '../formPrimitives';

interface Props {
    draft: Draft;
    set: (key: string, value: unknown) => void;
    /** The step's type: which of its fields hold values (the draft has no type). */
    stepType: string;
    groups?: unknown[];
    onFocusField?: unknown;
}

interface Pending { label: string; each: number; patch: Patch }

type Labels = Map<string, string>;

function countOf(source: MappingSource, previewSample: unknown): number | null {
    if (!previewSample) return null;
    const { items } = manyItems(walkSource(source as never, previewSample as object));
    return items.length || null;
}

/** The lists an author can pick, in words, with how many items each holds now. */
function ListChoices({ choices, current, onChoose, previewSample, labels, t }: {
    choices: RepeatChoice[]; current: MappingSource | null; onChoose: (c: RepeatChoice) => void;
    previewSample: unknown; labels: Labels; t: TranslateFn;
}) {
    return (
        <div className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)]/40 divide-y divide-[var(--border-default)]" data-testid="repeat-list-choices">
            {choices.length ? choices.map((c) => {
                const n = countOf(c.source, previewSample);
                const selected = !!current && JSON.stringify(current) === JSON.stringify(c.source);
                return (
                    <button
                        key={c.path}
                        type="button"
                        onClick={() => onChoose(c)}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[var(--bg-secondary)] ${selected ? 'bg-[var(--bg-secondary)]' : ''}`}
                    >
                        <Repeat size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                        <span className="text-[var(--text-primary)] truncate">{listLabel(c.source, labels, t)}</span>
                        {n != null && <span className="ml-auto text-[10px] text-[var(--text-tertiary)] tabular-nums">{t('mapping.repeat.n_items', '{count} items', { count: n })}</span>}
                        {selected && <Check size={12} className="shrink-0 text-[var(--accent)]" />}
                    </button>
                );
            }) : (
                <p className="px-2 py-1.5 text-[11px] text-[var(--text-tertiary)] italic">
                    {t('mapping.repeat.no_lists', 'No earlier step hands this step a list yet.')}
                </p>
            )}
        </div>
    );
}

/** The list the step repeats over now; a click opens the choices to move it. */
function CurrentList({ label, count, open, onToggle, t }: { label: string; count: number | null; open: boolean; onToggle: () => void; t: TranslateFn }) {
    return (
        <button
            type="button"
            onClick={onToggle}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/5 text-xs text-left"
            aria-expanded={open}
        >
            <Repeat size={12} className="shrink-0 text-[var(--accent)]" />
            <span className="truncate text-[var(--text-primary)]">{label}</span>
            {count != null && <span className="ml-auto text-[10px] text-[var(--text-tertiary)] tabular-nums">{t('mapping.repeat.n_times', '{count}×', { count })}</span>}
        </button>
    );
}

/** "At most [100]": the cap on how many items one run goes through. */
function MaxRow({ value, onChange, t }: { value: number | undefined; onChange: (n: number) => void; t: TranslateFn }) {
    const label = t('mapping.repeat.max', 'At most');
    return (
        <FormRow label={label} hint={t('mapping.repeat.max_hint', 'Items per run, 1 to 1000. The rest is skipped and the run says so.')}>
            <input
                type="number" min={1} max={1000}
                value={value ?? 100}
                onChange={(e) => onChange(Number(e.target.value))}
                className={inputClass()}
                aria-label={label}
            />
        </FormRow>
    );
}

/** What turning it on will do, before it is done. */
function RepeatPreview({ pending, onConfirm, onCancel, t }: { pending: Pending; onConfirm: () => void; onCancel: () => void; t: TranslateFn }) {
    let effect = t('mapping.repeat.preview_none', 'No value reads the current item yet, so every run would do the same thing. Pick values from that list once this is on.');
    if (pending.each === 1) effect = t('mapping.repeat.preview_one', '1 value will read the current item.');
    else if (pending.each > 1) effect = t('mapping.repeat.preview_many', '{n} values will read the current item.', { n: pending.each });
    return (
        <div className="pl-6 space-y-1.5" data-testid="repeat-preview">
            <p className="text-xs text-[var(--text-primary)]">
                {t('mapping.repeat.preview_list', 'Each item in {list}, one run per item.', { list: pending.label })}
            </p>
            <p className={pending.each ? 'text-[11px] text-[var(--text-secondary)]' : AMBER_NOTE}>{effect}</p>
            <div className="flex items-center gap-2">
                <button type="button" onClick={onConfirm} className="px-2 py-1 text-xs rounded bg-[var(--accent)] text-white hover:opacity-90">
                    {t('mapping.repeat.apply', 'Turn on')}
                </button>
                <button type="button" onClick={onCancel} className="px-2 py-1 text-xs rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">
                    {t('mapping.repeat.cancel', 'Cancel')}
                </button>
            </div>
        </div>
    );
}

/** The older per-item setting, editable as it is: its list, its item's name, its cap. */
function LegacyForEachRows({ forEach, count, groups, onFocusField, onChange, onMax, t }: {
    forEach: LegacyForEach; count: number | null; groups: unknown[]; onFocusField?: unknown;
    onChange: (change: { overRef?: string; itemVar?: string }) => void; onMax: (n: number) => void; t: TranslateFn;
}) {
    return (
        <div className="space-y-3 pl-6">
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('mapping.repeat.legacy_note', 'Set up the older way. It keeps working as it is.')}
            </p>
            <LoopOverPicker
                overRef={forEach.overRef || ''}
                itemVar={forEach.itemVar || 'item'}
                onChange={onChange}
                groups={groups as never}
                onFocusField={onFocusField}
            />
            {count != null && (
                <p className="text-[11px] text-[var(--text-secondary)] font-medium">
                    {t('mapping.repeat.runs_n_times', 'This step will run {count} times, once for each item.', { count })}
                </p>
            )}
            <MaxRow value={forEach.maxIterations} onChange={onMax} t={t} />
        </div>
    );
}

export default function StepRepeatSection({ draft, set, stepType, groups = [], onFocusField }: Props) {
    const { t } = useTranslation();
    const { previewSample, stepLabelById: labels } = useVariablePickerContext() as { previewSample: unknown; stepLabelById: Labels };
    const repeat = repeatOf(draft);
    const forEach = forEachOf(draft);
    const [choosing, setChoosing] = useState(false);
    const [pending, setPending] = useState<Pending | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const choices = useMemo(() => repeatChoices(groups as never, previewSample), [groups, previewSample]);
    const count = repeatCount(draft, previewSample);

    const apply = (patch: Patch) => { for (const [k, v] of Object.entries(patch)) set(k, v); };

    const turnOn = () => { setChoosing(true); setNote(null); };
    const turnOff = () => {
        setChoosing(false);
        setPending(null);
        setNote(null);
        if (repeat) { apply(planRepeatOff(draft, stepType).patch); return; }
        if (!forEach) return;
        const res = planForEachOff(draft, stepType);
        apply(res.patch);
        if (res.orphaned) setNote(t('mapping.repeat.off_orphaned', 'Some texts or formulas still read the current item. They will be empty now: check them above.'));
    };

    const choose = (choice: RepeatChoice) => {
        setNote(null);
        const res = repeat ? planRepeatSwitch(draft, stepType, choice.source) : planRepeat(draft, stepType, choice.source);
        if ('error' in res) {
            setNote(repeatRefusal(res.error, listLabel(repeat?.over || legacySource(forEach?.overRef), labels, t), t));
            return;
        }
        setPending({ label: listLabel(choice.source, labels, t), each: res.each, patch: res.patch });
        setChoosing(false);
    };

    const onLegacyChange = (change: { overRef?: string; itemVar?: string }) => {
        const res = planForEachChange(draft, stepType, change);
        if ('error' in res) { setNote(renameRefusal(res.error, t)); return; }
        setNote(null);
        apply(res.patch);
    };

    const chooser = <ListChoices choices={choices} current={repeat?.over || null} onChoose={choose} previewSample={previewSample} labels={labels} t={t} />;

    return (
        <div className="rounded-lg border border-[var(--border-default)] p-3 space-y-2" data-step-repeat-section="">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={!!(repeat || forEach || choosing || pending)} onChange={(e) => (e.target.checked ? turnOn() : turnOff())} />
                <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                    <Repeat size={13} /> {t('mapping.repeat.toggle', 'Run this step separately for each…')}
                </span>
            </label>

            {repeat && !pending && (
                <div className="space-y-2 pl-6">
                    <CurrentList label={listLabel(repeat.over, labels, t)} count={count} open={choosing} onToggle={() => setChoosing(c => !c)} t={t} />
                    {choosing && chooser}
                    <MaxRow value={repeat.max} onChange={(max) => set('repeat', { ...repeat, max })} t={t} />
                </div>
            )}

            {forEach && !repeat && (
                <LegacyForEachRows
                    forEach={forEach} count={count} groups={groups} onFocusField={onFocusField} t={t}
                    onChange={onLegacyChange}
                    onMax={(maxIterations) => set('forEach', { ...forEach, maxIterations })}
                />
            )}

            {choosing && !repeat && !forEach && !pending && <div className="pl-6">{chooser}</div>}

            {pending && (
                <RepeatPreview
                    pending={pending} t={t}
                    onConfirm={() => { apply(pending.patch); setPending(null); }}
                    onCancel={() => setPending(null)}
                />
            )}

            {note && <p className={`${AMBER_NOTE} pl-6`} role="status">{note}</p>}
        </div>
    );
}
