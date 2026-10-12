import { Plus, Trash2, Wand2 } from 'lucide-react';
import React from 'react';
import {
    COMPARE_SOURCES,
    blankCondition,
    conditionProblem,
    findRuleField,
    hasEmptyCheck,
    operatorsForField,
    ownRowsCondition,
    retypeCondition,
    ruleFields,
    valueKindOf,
} from './rowRuleModel';
import useTranslation from '../../../../../hooks/useTranslation';
import { optionPairs } from '../tables/rowValues';

/**
 * RowRuleBuilder — the clickable half of a row rule: rows of
 * [column] [test] [what to compare with], joined by all/any.
 *
 * It never touches the expression string itself; it edits the picker model
 * (rowRuleModel.js) and hands { join, conditions } back, so the ONE place that
 * writes the server's expression stays buildRowRule(). Columns come from the
 * table, and the value control is typed off the picked column — nothing here is
 * typed from memory.
 */

const selectClass = 'rounded border px-2 py-1 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] disabled:opacity-50';
const selectStyle = {
    background: 'var(--bg-primary)',
    borderColor: 'var(--border-default)',
    color: 'var(--text-primary)',
};

export default function RowRuleBuilder({ table, join = 'and', conditions = [], onChange, disabled = false }) {
    const { t } = useTranslation();
    const fields = ruleFields(table, t);
    const joins = [
        { value: 'and', label: t('studio_apps_edit.rule_builder.join_all', 'all of these') },
        { value: 'or', label: t('studio_apps_edit.rule_builder.join_any', 'any of these') },
    ];

    const emit = (next) => onChange?.({ join, conditions, ...next });
    const setCondition = (index, patch) => {
        emit({ conditions: conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)) });
    };
    const removeCondition = (index) => emit({ conditions: conditions.filter((_, i) => i !== index) });
    const addCondition = () => emit({ conditions: [...conditions, blankCondition(table)] });

    if (conditions.length === 0) {
        return (
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => emit({ conditions: [ownRowsCondition()] })}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                >
                    <Wand2 className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                    {t('studio_apps_edit.rule_builder.own_rows', 'Only rows they added themselves')}
                </button>
                <button
                    type="button"
                    onClick={addCondition}
                    disabled={disabled || fields.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('studio_apps_edit.rule_builder.add_condition', 'Add a condition')}
                </button>
            </div>
        );
    }

    return (
        <div data-testid="row-rule-builder" className="flex flex-col gap-2">
            {conditions.length > 1 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <span>{t('studio_apps_edit.rule_builder.they_see', 'They see a row when')}</span>
                    <select
                        value={join}
                        onChange={(e) => emit({ join: e.target.value })}
                        disabled={disabled}
                        aria-label={t('studio_apps_edit.rule_builder.match_aria', 'Match all or any')}
                        className={selectClass}
                        style={selectStyle}
                    >
                        {joins.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
                    </select>
                    <span>{t('studio_apps_edit.rule_builder.are_true', 'are true:')}</span>
                    {join === 'or' ? (
                        <span style={{ color: 'var(--text-tertiary)' }}>
                            {t('studio_apps_edit.rule_builder.or_hint', 'One match is enough, so each extra condition shows them more rows, not fewer.')}
                        </span>
                    ) : null}
                </div>
            ) : null}

            {conditions.map((condition, index) => (
                <ConditionRow
                    key={condition.id}
                    table={table}
                    fields={fields}
                    condition={condition}
                    index={index}
                    disabled={disabled}
                    onPatch={(patch) => setCondition(index, patch)}
                    onRemove={() => removeCondition(index)}
                />
            ))}

            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={addCondition}
                    disabled={disabled || fields.length === 0}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('studio_apps_edit.rule_builder.add_condition', 'Add a condition')}
                </button>
                {hasEmptyCheck({ conditions }) ? (
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {t('studio_apps_edit.rule_builder.blank_hint', 'Blank means the column holds empty text. Rows where it was never filled in at all stay out either way.')}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

/** One [column] [test] [compare with] row, plus what it is still missing. */
function ConditionRow({ table, fields, condition, index, disabled, onPatch, onRemove }) {
    const { t } = useTranslation();
    const field = findRuleField(table, condition.field);
    const problem = conditionProblem(condition, table, t);
    const needsValue = condition.op !== 'empty' && condition.op !== 'notEmpty';
    const num = index + 1;

    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={condition.field}
                    onChange={(e) => {
                        const next = findRuleField(table, e.target.value);
                        if (next) onPatch(retypeCondition(condition, next));
                    }}
                    disabled={disabled}
                    aria-label={t('studio_apps_edit.rule_builder.column_aria', 'Column, condition {n}', { n: num })}
                    className={selectClass}
                    style={selectStyle}
                >
                    {/* A column that was renamed away still shows, so the rule is not silently re-pointed. */}
                    {field ? null : <option value={condition.field}>{condition.field || t('studio_apps_edit.rule_builder.pick_column', 'Pick a column')}</option>}
                    {fields.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                </select>
                <select
                    value={condition.op}
                    onChange={(e) => onPatch({ op: e.target.value })}
                    disabled={disabled}
                    aria-label={t('studio_apps_edit.rule_builder.test_aria', 'Test, condition {n}', { n: num })}
                    className={selectClass}
                    style={selectStyle}
                >
                    {operatorsForField(field, condition.op, t).map((o) => (
                        <option key={o.op} value={o.op}>{o.label}</option>
                    ))}
                </select>
                {needsValue ? (
                    <select
                        value={condition.source}
                        onChange={(e) => onPatch({ source: e.target.value })}
                        disabled={disabled}
                        aria-label={t('studio_apps_edit.rule_builder.compare_aria', 'Compare with, condition {n}', { n: num })}
                        className={selectClass}
                        style={selectStyle}
                    >
                        {COMPARE_SOURCES.map((s) => <option key={s.id} value={s.id}>{t(s.labelKey, s.label)}</option>)}
                    </select>
                ) : null}
                {needsValue && condition.source === 'value' ? (
                    <ValueControl
                        kind={valueKindOf(field)}
                        field={field}
                        value={condition.value}
                        disabled={disabled}
                        label={t('studio_apps_edit.rule_builder.value_aria', 'Value, condition {n}', { n: num })}
                        onChange={(value) => onPatch({ value })}
                    />
                ) : null}
                <button
                    type="button"
                    onClick={onRemove}
                    disabled={disabled}
                    aria-label={t('studio_apps_edit.rule_builder.remove_aria', 'Remove condition {n}', { n: num })}
                    className="rounded p-1 hover:bg-rose-500/10 disabled:opacity-50"
                    style={{ color: 'var(--text-tertiary)' }}
                >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>
            {problem ? (
                <span className="text-[11px] text-amber-600 dark:text-amber-400">{problem}</span>
            ) : null}
        </div>
    );
}

const INPUT_TYPES = { number: 'number', date: 'date', datetime: 'datetime-local' };

/** The typed value control for the picked column. */
function ValueControl({ kind, field, value, onChange, label, disabled }) {
    const { t } = useTranslation();
    const v = value ?? '';
    const common = {
        disabled,
        'aria-label': label,
        className: `${selectClass} w-44`,
        style: selectStyle,
        onChange: (e) => onChange(e.target.value),
    };

    if (kind === 'yesno') {
        return (
            <select {...common} value={v === true || v === 'true' ? 'true' : 'false'}>
                <option value="true">{t('studio_apps_edit.rule_builder.yes', 'yes')}</option>
                <option value="false">{t('studio_apps_edit.rule_builder.no', 'no')}</option>
            </select>
        );
    }
    if (kind === 'choice') {
        // A select column's options may be plain strings OR {value,label}
        // objects — the shape optionPairs exists to normalise, and the one the
        // table designer writes whenever a choice is given a display name.
        // Rendering the raw entries put an OBJECT in a React child slot, which
        // throws: opening the row-rule builder on such a column crashed the
        // Roles & access panel outright.
        const options = optionPairs(field);
        // A saved value that is no longer one of the choices stays selectable.
        const extra = v !== '' && !options.some((o) => o.value === v) ? [{ value: v, label: v }] : [];
        return (
            <select {...common} value={v}>
                <option value="">{t('studio_apps_edit.rule_builder.pick_one', 'Pick one…')}</option>
                {[...options, ...extra].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        );
    }
    return (
        <input
            {...common}
            type={INPUT_TYPES[kind] || 'text'}
            // A leading minus would parse as arithmetic, which a row rule may not contain.
            min={kind === 'number' ? '0' : undefined}
            placeholder={kind === 'number' ? '0' : (kind === 'text' ? t('studio_apps_edit.rule_builder.type_value', 'type the value') : undefined)}
            value={v}
        />
    );
}
