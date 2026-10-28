// The form inside each kind of check card. Each body edits one entry and hands
// back the whole next entry; the section decides which list it lives in.
import { useTranslation } from '@/hooks/useTranslation';
import { FormRow, denseInputClass } from '../formPrimitives';
import { FieldSelect, ListSourceField, NumberBox, PathField, TickRow, type PickerProps } from './checkFields';
import type { AllowedFromCheck, ItemsCheck, NumbersFromCheck, ScriptCheck, FieldPathOption } from './reliabilityModel';
import { SCRIPTS } from './reliabilityModel';
import { useVariablePickerContext } from '@/components/automation/Builder/mapping/VariablePickerContext';

interface BodyProps<T> extends PickerProps {
    entry: T;
    onChange: (next: T) => void;
    fields: FieldPathOption[];
}

/** "Must be one of the values in a list" — stored in enumFrom (shown to the AI) or in checks. */
export function AllowedBody({ entry, onChange, fields, ariaBase, previewSample, onFocusField, shown, onShownChange, canShow }: BodyProps<AllowedFromCheck> & {
    shown: boolean; onShownChange: (next: boolean) => void; canShow: boolean;
}) {
    const { t } = useTranslation();
    return (
        <>
            <FieldSelect
                value={entry.field} fields={fields} kinds={['text']} ariaBase={ariaBase}
                onChange={(field) => onChange({ ...entry, field })}
                label={t('ai_step_checks.field_label', 'Field of the answer')}
                hint={t('ai_step_checks.allowed_field_hint', 'The text field whose value must be one of the allowed values.')}
            />
            <ListSourceField
                listRef={entry.ref} value={entry.value || ''} ariaBase={ariaBase} previewSample={previewSample} onFocusField={onFocusField}
                onChange={(next) => onChange({ ...entry, ref: next.ref, value: next.value })}
            />
            <TickRow
                checked={shown} disabled={!canShow && !shown} onChange={onShownChange}
                label={t('ai_step_checks.show_list', 'Show the list to the AI (recommended)')}
                hint={t('ai_step_checks.show_list_hint', 'The AI sees the allowed values and picks from them, so it gets the answer right the first time. They are sent to the AI model, protected by Privacy Shield like the rest of the prompt. Turn this off to keep the list private and only check the answer afterwards.')}
            />
            <TickRow
                checked={entry.ignoreCase !== false} onChange={(on) => onChange({ ...entry, ignoreCase: on })}
                label={t('ai_step_checks.ignore_case', 'Ignore upper and lower case')}
                hint={t('ai_step_checks.ignore_case_hint', 'Paris and paris count as the same value.')}
            />
            <TickRow
                checked={entry.allowEmpty === true} onChange={(on) => onChange({ ...entry, allowEmpty: on })}
                label={t('ai_step_checks.allow_empty', 'May be left empty')}
                hint={t('ai_step_checks.allow_empty_hint', 'An empty answer is accepted when the AI finds nothing to fill in.')}
            />
        </>
    );
}

/** "Numbers must come from the data". */
export function NumbersBody({ entry, onChange, fields, ariaBase, previewSample, onFocusField }: BodyProps<NumbersFromCheck>) {
    const { t } = useTranslation();
    const ctx = useVariablePickerContext();
    return (
        <>
            <FieldSelect
                value={entry.field} fields={fields} kinds={['text']} ariaBase={ariaBase}
                onChange={(field) => onChange({ ...entry, field })}
                label={t('ai_step_checks.field_label', 'Field of the answer')}
                hint={t('ai_step_checks.numbers_field_hint', 'The text field to look at. Every number written in it must also appear in the data below.')}
            />
            <FormRow
                label={t('ai_step_checks.numbers_source_label', 'Data the numbers must come from')}
                hint={t('ai_step_checks.numbers_source_hint', 'Any earlier value: the text that was summarised, a table, a record. A number the AI makes up is caught because it is not in here.')}
            >
                <PathField
                    value={entry.ref}
                    onChange={(v: string) => onChange({ ...entry, ref: v.trim() })}
                    onFocusField={onFocusField}
                    previewSample={previewSample ?? ctx.previewSample}
                    placeholder={t('ai_step_checks.numbers_source_empty', 'No data picked yet')}
                />
            </FormRow>
            <div className="flex flex-wrap gap-3">
                <NumberBox
                    value={entry.tolerance} min={0} step={0.01} ariaLabel={`${ariaBase} ${t('ai_step_checks.tolerance_label', 'Allowed difference')}`}
                    onChange={(tolerance) => onChange({ ...entry, tolerance })}
                    label={t('ai_step_checks.tolerance_label', 'Allowed difference')}
                    hint={t('ai_step_checks.tolerance_hint', 'How far a number may differ from the data, in the same unit. 0 means exactly equal; 0.5 allows a rounding of half a unit.')}
                />
                <NumberBox
                    value={entry.ignoreUpTo} min={0} max={1000} ariaLabel={`${ariaBase} ${t('ai_step_checks.ignore_up_to_label', 'Ignore small whole numbers up to')}`}
                    onChange={(ignoreUpTo) => onChange({ ...entry, ignoreUpTo })}
                    label={t('ai_step_checks.ignore_up_to_label', 'Ignore small whole numbers up to')}
                    hint={t('ai_step_checks.ignore_up_to_hint', 'Numbers like the 3 in "3 reasons" or list numbers are not checked. Leave empty to check every number.')}
                />
            </div>
            <TickRow
                checked={entry.percent !== false} onChange={(on) => onChange({ ...entry, percent: on })}
                label={t('ai_step_checks.check_percent', 'Check percentages too')}
                hint={t('ai_step_checks.check_percent_hint', 'A percentage such as 12% is checked like any other number.')}
            />
            <TickRow
                checked={entry.ignoreDates !== false} onChange={(on) => onChange({ ...entry, ignoreDates: on })}
                label={t('ai_step_checks.ignore_dates', 'Ignore dates and years')}
                hint={t('ai_step_checks.ignore_dates_hint', 'Numbers that are part of a date, such as 2024-05-17 or 17 May 2024, are not checked.')}
            />
        </>
    );
}

/** Human names for the writing systems. Keys are the server's. */
function useScriptLabels(): Record<string, string> {
    const { t } = useTranslation();
    return {
        latin: t('ai_step_checks.script_latin', 'Latin'),
        cyrillic: t('ai_step_checks.script_cyrillic', 'Cyrillic'),
        greek: t('ai_step_checks.script_greek', 'Greek'),
        arabic: t('ai_step_checks.script_arabic', 'Arabic'),
        hebrew: t('ai_step_checks.script_hebrew', 'Hebrew'),
        han: t('ai_step_checks.script_han', 'Chinese characters'),
        japanese: t('ai_step_checks.script_japanese', 'Japanese'),
        hangul: t('ai_step_checks.script_hangul', 'Korean'),
        devanagari: t('ai_step_checks.script_devanagari', 'Devanagari'),
        thai: t('ai_step_checks.script_thai', 'Thai'),
    };
}

/** "Written in one alphabet". */
export function ScriptBody({ entry, onChange, fields, ariaBase }: BodyProps<ScriptCheck>) {
    const { t } = useTranslation();
    const labels = useScriptLabels();
    return (
        <>
            <FieldSelect
                value={entry.field} fields={fields} kinds={['text']} ariaBase={ariaBase}
                onChange={(field) => onChange({ ...entry, field })}
                label={t('ai_step_checks.field_label', 'Field of the answer')}
                hint={t('ai_step_checks.script_field_hint', 'The text field that must be written in one alphabet.')}
            />
            <FormRow
                label={t('ai_step_checks.script_label', 'Alphabet')}
                hint={t('ai_step_checks.script_hint', 'Catches an answer that switched language halfway. Digits, spaces and punctuation are ignored; only letters count.')}
            >
                <select
                    aria-label={`${ariaBase} ${t('ai_step_checks.script_label', 'Alphabet')}`}
                    value={entry.script}
                    onChange={(e) => onChange({ ...entry, script: e.target.value })}
                    className={denseInputClass('w-full')}
                >
                    {entry.script && !(SCRIPTS as readonly string[]).includes(entry.script) && <option value={entry.script}>{entry.script}</option>}
                    {SCRIPTS.map(s => <option key={s} value={s}>{labels[s]}</option>)}
                </select>
            </FormRow>
        </>
    );
}

/** "Number of items". */
export function ItemsBody({ entry, onChange, fields, ariaBase, previewSample, onFocusField }: BodyProps<ItemsCheck>) {
    const { t } = useTranslation();
    const ctx = useVariablePickerContext();
    return (
        <>
            <FieldSelect
                value={entry.field} fields={fields} kinds={['list']} ariaBase={ariaBase}
                onChange={(field) => onChange({ ...entry, field })}
                label={t('ai_step_checks.list_field_label', 'List in the answer')}
                hint={t('ai_step_checks.items_field_hint', 'The list whose length is checked.')}
            />
            <div className="flex flex-wrap gap-3">
                <NumberBox
                    value={entry.minItems} min={0} max={10000} ariaLabel={`${ariaBase} ${t('ai_step_checks.min_items', 'At least')}`}
                    onChange={(minItems) => onChange({ ...entry, minItems })}
                    label={t('ai_step_checks.min_items', 'At least')}
                    hint={t('ai_step_checks.min_items_hint', 'The fewest items the list may have. Leave empty for no minimum.')}
                />
                <NumberBox
                    value={entry.maxItems} min={0} max={10000} ariaLabel={`${ariaBase} ${t('ai_step_checks.max_items', 'At most')}`}
                    onChange={(maxItems) => onChange({ ...entry, maxItems })}
                    label={t('ai_step_checks.max_items', 'At most')}
                    hint={t('ai_step_checks.max_items_hint', 'The most items the list may have. Leave empty for no maximum.')}
                />
            </div>
            <FormRow
                label={t('ai_step_checks.same_count', 'Same number as the list')}
                hint={t('ai_step_checks.same_count_hint', 'Optional. Pick a list from an earlier step: the answer must have exactly as many items, for example one result per input row.')}
            >
                <PathField
                    value={entry.sameCountAs || ''}
                    onChange={(v: string) => onChange({ ...entry, sameCountAs: v.trim() })}
                    expectArray
                    onFocusField={onFocusField}
                    previewSample={previewSample ?? ctx.previewSample}
                    placeholder={t('ai_step_checks.same_count_empty', 'Not compared with a list')}
                />
            </FormRow>
        </>
    );
}
