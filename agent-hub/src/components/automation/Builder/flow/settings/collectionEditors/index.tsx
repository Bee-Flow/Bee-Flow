// Shared sections (ForEachSection, RetrySection, FieldsSection,
// SourceSummaryRow, CollectionArrayRefField, useElementSample) plus the small
// collection / datetime / wait step editors, extracted verbatim from
// SettingsForm.jsx.
import { Repeat } from 'lucide-react';
import { useMemo, type JSX } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { walkPath } from '@/utils/bindingHelpers';
import FieldKeyCombobox from '@/components/automation/Builder/mapping/FieldKeyCombobox';
import { applyStepBindings, stepBindings } from '@/components/automation/Builder/mapping/forEachBindings';
import LoopOverPicker from '@/components/automation/Builder/mapping/LoopOverPicker';
import PathField from '@/components/automation/Builder/mapping/PathField';
import ToolInputForm from '@/components/automation/Builder/mapping/ToolInputForm';
import { resolveElementSample, elementFieldOptions } from '@/components/automation/Builder/mapping/upstream';
import { useVariablePickerContext } from '@/components/automation/Builder/mapping/VariablePickerContext';
import AccordionSection from '../../AccordionSection';
import { datetimeTargetColumn, dateInputPatch } from '../../datetimeTarget';
import { FormRow, inputClass } from '../formPrimitives';
import type React from 'react';
import type { FormRecord } from '../formState/types';
import type { OnFocusField } from '@/components/automation/Builder/mapping/focusField.types';
import type { StepEditorProps, ForEachSectionProps, FieldsSectionProps, DateTimeFieldsProps, LimitFieldsProps, DedupeFieldsProps, AggregateFieldsProps, SummarizeFieldsProps } from '../collectionEditors.types';
import { SourceSummaryRow, CollectionArrayRefField } from './SourceSummaryRow';
import { RetrySection } from './RetrySection';
import { WaitFields } from './WaitFields';
export type { StepEditorProps } from '../collectionEditors.types';

function ForEachSection({ draft, set, groups, onFocusField, children = null }: ForEachSectionProps) {
    const { t } = useTranslation();
    const fe = draft.forEach || null;
    const enabled = !!fe;
    const { previewSample } = useVariablePickerContext();
    const toggle = (on: boolean) => set('forEach', on
        ? { overRef: fe?.overRef || '', itemVar: fe?.itemVar || 'item', maxIterations: fe?.maxIterations ?? 100 }
        : null);
    // How many times this step would actually run — resolved from the merged
    // real/sample root, so it is the same number the run will produce.
    const overCount = (() => {
        if (!enabled || !fe?.overRef || !previewSample) return null;
        const arr = walkPath(fe.overRef, previewSample);
        return Array.isArray(arr) ? arr.length : null;
    })();
    return (
        <div className="rounded-lg border border-[var(--border-default)] p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
                <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                    <Repeat size={13} /> {t('automations.collection_editors.run_once_per_item', 'Run once per item')}
                </span>
            </label>
            {/* Plain words first; the raw loop.<var> syntax is demoted to the
                tooltip — it used to LEAD this sentence. */}
            <p className="text-[11px] text-[var(--text-secondary)]" title={`Reference each one as loop.${fe?.itemVar || 'item'}`}>
                {t('automations.collection_editors.each_row_is_available_to_this', 'Each row is available to this step as its current row.')}
            </p>
            {overCount != null && (
                <p className="text-[11px] text-[var(--text-secondary)] font-medium">
                    {overCount === 1 ? t('automations.collection_editors.will_run_once', 'This step will run 1 time, once for each row.') : t('automations.collection_editors.will_run_times', 'This step will run {count} times, once for each row.', { count: overCount })}
                </p>
            )}
            {enabled && (
                <div className="space-y-3 pt-1">
                    <LoopOverPicker
                        overRef={fe.overRef || ''}
                        itemVar={fe.itemVar || 'item'}
                        parents={fe.parents}
                        onChange={(patch) => set('forEach', { ...fe, ...patch })}
                        groups={groups}
                        onFocusField={onFocusField ?? undefined}
                        // Another list: the step's fields follow the item (or
                        // are named when the new item lacks them), with Undo.
                        bindings={stepBindings(draft)}
                        onRebind={(next) => applyStepBindings(draft, next as Record<string, unknown>, set)}
                    />
                    <FormRow label={t('automations.collection_editors.max_iterations', 'Max iterations')} hint={t('automations.collection_editors.safety_cap_1_1000', 'Safety cap. 1–1000.')}>
                        <input
                            type="number" min={1} max={1000}
                            value={fe.maxIterations ?? 100}
                            onChange={(e) => set('forEach', { ...fe, maxIterations: Number(e.target.value) })}
                            className={inputClass()}
                        />
                    </FormRow>{children}
                </div>
            )}
        </div>
    );
}

/**
 * Whether this step's retry row counts as CONFIGURED — what the Advanced
 * section's collapsed "has content" dot is asking. `max: 0` is the runner's
 * own "do not retry" and reads as off here for the same reason it does in
 * the row itself, so a step carrying one is not advertised as having a
 * setting the author would open the section and fail to find.
 */
function retryIsSet(draft: FormRecord) {
    return !!(draft && draft.retry && Number(draft.retry.max) > 0);
}

function FieldsSection({
    draft, set, stepType, title, hint, onFocusField, previewSample,
    errorSections = new Set(), footer = null, inputProps = null,
}: FieldsSectionProps) {
    return (
        <AccordionSection stepType={stepType} sectionKey="fields" title={title} defaultOpen forceOpen={errorSections.has('fields')}>
            {/* The hint is a plain sentence, not a FormRow with a (?) icon: the
                accordion header already carries the title, so a FormRow here
                printed the same words twice and hid the explanation behind a
                tooltip nobody opens. */}
            {hint && <p className="text-[11px] text-[var(--text-tertiary)] mb-2">{hint}</p>}
            <ToolInputForm
                inputs={draft.fields || {}}
                onChange={(next) => set('fields', next)}
                inputSchema={null}
                keepEmptyFields
                onFocusField={onFocusField}
                previewSample={previewSample}
                {...(inputProps || {})}
            />
            {footer}
        </AccordionSection>
    );
}

/**
 * Resolve the current element shape of a collection op's source array so its
 * sub-fields (keyField/field, filter's `item.*` conditions) get suggestions
 * with real samples. previewSample is the NDV's merged root (design-time
 * samples + real-run/pinned overlays), so a dry-run upgrades the options.
 */
function useElementSample(arrayRef: string | undefined, previewSample: unknown) {
    return useMemo(() => resolveElementSample(arrayRef, previewSample), [arrayRef, previewSample]);
}

function DateTimeFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }: DateTimeFieldsProps) {
    const { t } = useTranslation();
    const op = draft.op || 'now';
    const needsInput = op !== 'now';
    const needsInput2 = op === 'diff';
    const needsAmount = op === 'addDays' || op === 'addHours' || op === 'addMinutes';
    // Same present-or-absent convention as the Condition and Edit data nodes.
    const listMode = typeof draft.arrayRef === 'string';
    const column = datetimeTargetColumn(draft);
    return (
        <AccordionSection stepType="datetime" sectionKey="config" title={t('automations.collection_editors.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
            <FormRow label={t('automations.collection_editors.operation', 'Operation')}>
                <select value={op} onChange={(e) => set('op', e.target.value)} className={inputClass()}>
                    <option value="now">{t('automations.collection_editors.today_s_date_and_time', 'Today’s date and time')}</option>
                    <option value="parse">{t('automations.collection_editors.read_a_date_out_of_text', 'Read a date out of text')}</option>
                    <option value="format">{t('automations.collection_editors.reformat_a_date', 'Reformat a date')}</option>
                    <option value="addDays">{t('automations.collection_editors.add_days', 'Add days')}</option>
                    <option value="addHours">{t('automations.collection_editors.add_hours', 'Add hours')}</option>
                    <option value="addMinutes">{t('automations.collection_editors.add_minutes', 'Add minutes')}</option>
                    <option value="diff">{t('automations.collection_editors.time_between_two_dates', 'Time between two dates')}</option>
                    <option value="extract">{t('automations.collection_editors.take_one_part_of_a_date', 'Take one part of a date')}</option>
                </select>
            </FormRow>
            {/* One date, or a whole column of them. Dropping a column into
                "Input date" switches this automatically — before, the array
                reached the date parser whole and the step just failed. */}
            {op !== 'now' && (
                <FormRow label={t('automations.collection_editors.works_on', 'Works on')} hint={t('automations.collection_editors.set_automatically_when_you_drop_a', 'Set automatically when you drop a whole column into the input below.')}>
                    <select
                        value={listMode ? 'items' : 'single'}
                        onChange={(e) => set('arrayRef', e.target.value === 'items' ? (draft.arrayRef ?? '') : null)}
                        className={inputClass()}
                    >
                        <option value="single">{t('automations.collection_editors.one_date', 'One date')}</option>
                        <option value="items">{t('automations.collection_editors.each_row_of_a_list', 'Each row of a list')}</option>
                    </select>
                </FormRow>
            )}
            {listMode && (
                <CollectionArrayRefField
                    draft={draft}
                    set={set}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            )}
            {needsInput && (
                <FormRow
                    label={t('automations.collection_editors.input_date', 'Input date')}
                    hint={listMode
                        ? 'Which column of that list holds the date. Write it as item.<column>.'
                        : 'Pick a date from a previous step, or type a fixed date like 2026-07-01.'}
                >
                    <PathField
                        value={draft.input || ''}
                        onChange={(v: unknown) => {
                            // A dropped COLUMN switches the step to list mode —
                            // see dateInputPatch for why.
                            for (const [k, val] of Object.entries(dateInputPatch(v, { listMode }))) set(k, val);
                        }}
                        allowLiteral="date"
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={listMode ? 'item.updated' : 'trigger.output.timestamp'}
                    />
                </FormRow>
            )}
            {listMode && (
                <FormRow
                    label={t('automations.collection_editors.new_column', 'New column')}
                    hint={`Every row keeps its own columns and gains this one. Leave empty to call it “${column}”.`}
                >
                    <input
                        type="text"
                        value={draft.target || ''}
                        onChange={(e) => set('target', e.target.value)}
                        placeholder={column}
                        className={inputClass()}
                    />
                </FormRow>
            )}
            {needsInput2 && (
                <FormRow label={t('automations.collection_editors.second_date', 'Second date')} hint={t('automations.collection_editors.difference_is_calculated_as_second_date', 'Difference is calculated as second date − input date.')}>
                    <PathField
                        value={draft.input2 || ''}
                        onChange={(v) => set('input2', v)}
                        allowLiteral="date"
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="trigger.output.endsAt"
                    />
                </FormRow>
            )}
            {needsAmount && (
                <FormRow label={t('automations.collection_editors.amount_2', 'Amount')} hint={t('automations.collection_editors.positive_to_add_negative_to_subtract', 'Positive to add, negative to subtract.')}>
                    <input type="number" value={draft.amount ?? 0} onChange={(e) => set('amount', Number(e.target.value))} className={inputClass()} />
                </FormRow>
            )}
            {op === 'format' && (
                <FormRow label={t('automations.collection_editors.format', 'Format')} hint={t('automations.collection_editors.how_the_date_should_be_written', 'How the date should be written. Building blocks: yyyy (year), MM (month), dd (day), HH, mm, ss.')}>
                    <input type="text" value={draft.format || ''} onChange={(e) => set('format', e.target.value)} placeholder={t('automations.collection_editors.yyyy_mm_dd_hh_mm', 'yyyy-MM-dd HH:mm')} className={inputClass() + ' font-mono'} />
                </FormRow>
            )}
            {op === 'extract' && (
                <FormRow label={t('automations.collection_editors.part', 'Part')}>
                    <select value={draft.part || 'year'} onChange={(e) => set('part', e.target.value)} className={inputClass()}>
                        <option value="year">{t('automations.collection_editors.year', 'year')}</option>
                        <option value="month">{t('automations.collection_editors.month', 'month')}</option>
                        <option value="day">{t('automations.collection_editors.day', 'day')}</option>
                        <option value="hour">{t('automations.collection_editors.hour', 'hour')}</option>
                        <option value="minute">{t('automations.collection_editors.minute', 'minute')}</option>
                        <option value="second">{t('automations.collection_editors.second', 'second')}</option>
                        <option value="dayOfWeek">{t('automations.collection_editors.day_of_the_week', 'day of the week')}</option>
                    </select>
                </FormRow>
            )}
            {op === 'diff' && (
                <FormRow label={t('automations.collection_editors.unit', 'Unit')}>
                    <select value={draft.unit || 'days'} onChange={(e) => set('unit', e.target.value)} className={inputClass()}>
                        <option value="days">{t('automations.collection_editors.days', 'days')}</option>
                        <option value="hours">{t('automations.collection_editors.hours', 'hours')}</option>
                        <option value="minutes">{t('automations.collection_editors.minutes', 'minutes')}</option>
                        <option value="seconds">{t('automations.collection_editors.seconds', 'seconds')}</option>
                    </select>
                </FormRow>
            )}
        </AccordionSection>
    );
}

function LimitFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }: LimitFieldsProps) {
    const { t } = useTranslation();
    return (
        <AccordionSection stepType="limit" sectionKey="config" title={t('automations.collection_editors.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            <FormRow label={t('automations.collection_editors.which_end', 'Which end')}>
                <select value={draft.mode || 'first'} onChange={(e) => set('mode', e.target.value)} className={inputClass()}>
                    <option value="first">{t('automations.collection_editors.keep_the_first_few', 'Keep the first few')}</option>
                    <option value="last">{t('automations.collection_editors.keep_the_last_few', 'Keep the last few')}</option>
                </select>
            </FormRow>
            <FormRow label={t('automations.collection_editors.how_many_to_keep', 'How many to keep')} hint={t('automations.collection_editors.0_keeps_nothing', '0 keeps nothing.')}>
                <input type="number" min={0} value={draft.count ?? 10} onChange={(e) => set('count', Number(e.target.value))} className={inputClass()} />
            </FormRow>
        </AccordionSection>
    );
}

function DedupeFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }: DedupeFieldsProps) {
    const { t } = useTranslation();
    const elementSample = useElementSample(draft.arrayRef, previewSample);
    const options = useMemo(() => elementFieldOptions(elementSample), [elementSample]);
    return (
        <AccordionSection stepType="dedupe" sectionKey="config" title={t('automations.collection_editors.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            <FormRow label={t('automations.collection_editors.key_field', 'Key field')} hint={t('automations.collection_editors.optional_two_items_with_the_same', 'Optional. Two items with the same value here count as the same item. Leave it blank to drop only items that are identical all the way through.')}>
                <FieldKeyCombobox value={draft.keyField || ''} onChange={(v) => set('keyField', v)} options={options} placeholder={t('automations.collection_editors.id', 'id')} label={t('automations.collection_editors.key_field', 'Key field')} onFocusField={onFocusField} />
            </FormRow>
        </AccordionSection>
    );
}

function AggregateFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }: AggregateFieldsProps) {
    const { t } = useTranslation();
    const elementSample = useElementSample(draft.arrayRef, previewSample);
    const options = useMemo(() => elementFieldOptions(elementSample), [elementSample]);
    return (
        <AccordionSection stepType="aggregate" sectionKey="config" title={t('automations.collection_editors.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            <FormRow label={t('automations.collection_editors.field', 'Field')} hint={t('automations.collection_editors.the_field_to_take_from_every', 'The field to take from every item. The result is a plain list of just those values. If no item has this field the step is skipped rather than handing on a list of blanks.')}>
                <FieldKeyCombobox value={draft.field || ''} onChange={(v) => set('field', v)} options={options} placeholder={t('automations.collection_editors.email', 'email')} label={t('automations.collection_editors.field', 'Field')} onFocusField={onFocusField} />
            </FormRow>
        </AccordionSection>
    );
}

function SummarizeFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }: SummarizeFieldsProps) {
    const { t } = useTranslation();
    const elementSample = useElementSample(draft.arrayRef, previewSample);
    const options = useMemo(() => elementFieldOptions(elementSample), [elementSample]);
    return (
        <AccordionSection stepType="summarize" sectionKey="config" title={t('automations.collection_editors.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            {/* `count` ignores the field entirely (it counts items), so asking
                for one there would be misleading. */}
            {draft.op !== 'count' && (
                <FormRow label={t('automations.collection_editors.field', 'Field')} hint={t('automations.collection_editors.the_number_to_work_with_read', 'The number to work with, read from every item. If no item has this field the step is skipped rather than reporting 0.')}>
                    <FieldKeyCombobox value={draft.field || ''} onChange={(v) => set('field', v)} options={options} placeholder={t('automations.collection_editors.amount', 'amount')} label={t('automations.collection_editors.field', 'Field')} onFocusField={onFocusField} />
                </FormRow>
            )}
            <FormRow label={t('automations.collection_editors.what_to_work_out', 'What to work out')}>
                <select value={draft.op || 'sum'} onChange={(e) => set('op', e.target.value)} className={inputClass()}>
                    <option value="sum">{t('automations.collection_editors.total_add_them_all_up', 'Total — add them all up')}</option>
                    <option value="count">{t('automations.collection_editors.count_how_many_items', 'Count — how many items')}</option>
                    <option value="avg">{t('automations.collection_editors.average', 'Average')}</option>
                    <option value="min">{t('automations.collection_editors.lowest', 'Lowest')}</option>
                    <option value="max">{t('automations.collection_editors.highest', 'Highest')}</option>
                </select>
            </FormRow>
        </AccordionSection>
    );
}

export {
    ForEachSection, RetrySection, retryIsSet, FieldsSection, SourceSummaryRow, CollectionArrayRefField, useElementSample,
    DateTimeFields, WaitFields, LimitFields, DedupeFields, AggregateFields, SummarizeFields,
};
