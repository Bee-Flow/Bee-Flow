import { getList } from '@shared/expr/path.mjs';
import { useMemo, type ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import PathFieldJs from '../../../mapping/PathField';
import { collectArrayPaths } from '../../../mapping/upstream';
import { useVariablePickerContext } from '../../../mapping/VariablePickerContext';
import type { OnFocusField } from '../../../mapping/focusField.types';
import { FormRow, denseInputClass } from '../formPrimitives';
import type { SourceSpec } from './fieldEditor.types';

// A JavaScript component whose props TypeScript infers from their defaults.
const PathField = PathFieldJs;

/** The cap the server applies to `limit` (formDynamicFields MAX_SOURCE_LIMIT). */
const SOURCE_LIMIT_MAX = 10000;

interface Props {
    spec: SourceSpec | null | undefined;
    onChange: (next: SourceSpec) => void;
    /** What each item becomes, for the labels: 'choices' or 'questions'. */
    kind: 'choices' | 'questions';
    /** Name used in aria-labels, e.g. "Question 2". */
    ariaBase: string;
    previewSample?: unknown;
    onFocusField?: OnFocusField | null;
}

type Slot = 'value' | 'label' | 'hint';

/** Keys of the first item of the sample list, when its items are records. */
function sampleKeys(list: unknown[] | null): string[] {
    const first = list?.[0];
    return first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first as Record<string, unknown>) : [];
}

/** Drop the keys that are empty, so the stored spec only carries what the author chose. */
function tidy(spec: SourceSpec): SourceSpec {
    const out: SourceSpec = { ref: spec.ref };
    for (const k of ['value', 'label', 'hint'] as const) if (spec[k]) out[k] = spec[k];
    if (spec.limit) out.limit = spec.limit;
    return out;
}

/** Which part of each item is the value / the label / the hint: a pick from the sample's keys, or typed. */
function ItemPart({ slot, label, none, hint, spec, keys, ariaBase, set }: {
    slot: Slot; label: string; none: string; hint: string; spec: SourceSpec | null | undefined;
    keys: string[]; ariaBase: string; set: (changes: Partial<SourceSpec>) => void;
}) {
    const current = spec?.[slot] || '';
    const aria = `${ariaBase} ${slot}`;
    return (
        <FormRow label={label} hint={hint}>
            {keys.length > 0 ? (
                <select aria-label={aria} value={current} onChange={(e) => set({ [slot]: e.target.value })} className={denseInputClass('w-full')}>
                    <option value="">{none}</option>
                    {current && !keys.includes(current) && <option value={current}>{current}</option>}
                    {keys.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
            ) : (
                <input
                    type="text"
                    aria-label={aria}
                    value={current}
                    onChange={(e) => set({ [slot]: e.target.value.trim() })}
                    className={denseInputClass('w-full')}
                    placeholder={none}
                />
            )}
        </FormRow>
    );
}

function LimitRow({ spec, ariaBase, set }: { spec: SourceSpec | null | undefined; ariaBase: string; set: (changes: Partial<SourceSpec>) => void }) {
    const { t } = useTranslation();
    return (
        <FormRow label={t('automations.form_wizard.limit_label', 'At most')} hint={t('automations.form_wizard.limit_hint', 'Leave blank to take all of them, up to the platform limit.')}>
            <input
                type="number"
                min={1}
                max={SOURCE_LIMIT_MAX}
                aria-label={`${ariaBase} limit`}
                value={spec?.limit ?? ''}
                onChange={(e) => set({ limit: e.target.value === '' ? undefined : Math.min(SOURCE_LIMIT_MAX, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })}
                className={denseInputClass('w-28')}
            />
        </FormRow>
    );
}

/**
 * Where a list of choices (or of per-item questions) comes from: the list on
 * an earlier step, which part of each item is the value, the label and the
 * hint, and how many to take. The three item parts are picked from the keys of
 * the first item of the sample list; without a sample they are typed.
 *
 * Shared by "Choices from an earlier step" and "Ask once per item".
 */
export default function SourceSpecEditor({ spec, onChange, kind, ariaBase, previewSample = null, onFocusField = null }: Props) {
    const { t } = useTranslation();
    const ctx = useVariablePickerContext();
    const sample = previewSample ?? ctx.previewSample;
    const ref = spec?.ref || '';
    const quickPicks = useMemo(() => collectArrayPaths(ctx.groups, sample), [ctx.groups, sample]);
    const list = useMemo(() => (ref && sample ? getList(sample, ref) as unknown[] | null : null), [ref, sample]);
    const keys = sampleKeys(list);
    const set = (changes: Partial<SourceSpec>) => onChange(tidy({ ...(spec || { ref: '' }), ...changes }));
    const choices = kind === 'choices';
    const part = { spec, keys, ariaBase, set };

    return (
        <div className="space-y-2">
            <FormRow
                label={t('automations.form_wizard.list_label', 'List')}
                hint={list
                    ? t('automations.form_wizard.list_sample_count', '{n} in the example data.', { n: list.length })
                    : t('automations.form_wizard.list_pick_hint', 'Pick a list from an earlier step.')}
            >
                <PathField
                    value={ref}
                    onChange={(v: string) => set({ ref: v.trim() })}
                    expectArray
                    quickPicks={quickPicks}
                    onFocusField={onFocusField}
                    previewSample={sample}
                    placeholder={t('automations.form_wizard.no_list_yet', 'No list picked yet')}
                />
            </FormRow>
            {choices && (
                <p className="text-[10px] text-[var(--text-tertiary)]">
                    {t('automations.form_wizard.value_label_help', 'The answer is the value; the label is only what people read. Route on the value.')}
                </p>
            )}
            <ItemPart
                {...part}
                slot="value"
                label={choices ? t('automations.form_wizard.value_label', 'Answer (value)') : t('automations.form_wizard.item_key_label', 'Identifies the item')}
                none={t('automations.form_wizard.value_none', 'The item itself')}
                hint={choices
                    ? t('automations.form_wizard.value_hint', 'Which part of each item is stored as the answer.')
                    : t('automations.form_wizard.item_key_hint', 'Stored next to each answer, so you can tell which item it was for.')}
            />
            <ItemPart
                {...part}
                slot="label"
                label={choices ? t('automations.form_wizard.label_label', 'Shown as (label)') : t('automations.form_wizard.item_title_label', 'Shown as the question')}
                none={t('automations.form_wizard.label_none', 'Same as the value')}
                hint={t('automations.form_wizard.label_hint', 'What people read.')}
            />
            <ItemPart
                {...part}
                slot="hint"
                label={t('automations.form_wizard.hint_label', 'Extra line (optional)')}
                none={t('automations.form_wizard.hint_none', 'None')}
                hint={choices
                    ? t('automations.form_wizard.hint_hint_choices', 'A short note shown under the choice.')
                    : t('automations.form_wizard.hint_hint_questions', 'A short note shown under the question.')}
            />
            <LimitRow spec={spec} ariaBase={ariaBase} set={set} />
        </div>
    );
}
