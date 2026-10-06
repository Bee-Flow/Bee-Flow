/**
 * One rule row of the clickable condition editor:
 *
 *   [any attachment ▾] [Mime type] [contains ▾] [pdf]
 *
 * plus the plain-language notes that belong to that row (a list compared as
 * one value, a field the sample does not have, a list path outside a
 * quantifier). The row's state lives in ConditionBuilder; this renders it and
 * hands back whole rows, so picking a field can reset the operator and set or
 * clear the quantifier in one change (conditionModel.rowForField).
 */
import { formatPath, getList, getPath, parsePath } from '@shared/expr/path.mjs';
import { fieldShape, singularKey } from '@shared/expr/rules.mjs';
import { Trash2 } from 'lucide-react';
import type { ComponentType } from 'react';
import BindingFieldJs from './BindingField';
import ConditionValueSlot, { type Binding } from './ConditionBuilderValueSlot';
import FieldPickerJs from './FieldPicker';
import { FileTypeSelect, QuantifierSelect, type Quantifier } from './RuleRowParts';
import TopicValueSlot, { type TopicRowPatch } from './TopicValueSlot';
import useTranslation from '../../../../hooks/useTranslation';
import { walkPath } from '../../../../utils/bindingHelpers';
import { humanizeFieldKey, humanizeFieldTail } from '../flow/displayHelpers';
import { AMBER_NOTE, denseInputClass } from '../flow/settings/formStyles';
import { isTopicOp, isUnaryOp, labelFor, operatorsForType, rowForField, rowType } from '../utils/conditionModel';

// JS components: TypeScript reads every prop without a default as required.
const BindingField = BindingFieldJs as unknown as ComponentType<Record<string, unknown>>;
const FieldPicker = FieldPickerJs as unknown as ComponentType<Record<string, unknown>>;

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

export interface RuleRow {
    field: Binding;
    op: string;
    value: Binding;
    threshold?: number;
    quantifier?: Quantifier;
    keepBlank?: true;
}

export interface FieldOption { path: string; label?: string; sample?: unknown; group?: string }

interface Props {
    row: RuleRow;
    previewSample: unknown;
    fieldOptions: FieldOption[] | null;
    fieldBase: string;
    /** Simple mode: names only, no way into an expression. */
    simple: boolean;
    /** The author chose to type this row's field as an expression (Advanced only). */
    rawField: boolean;
    context: string;
    topics?: { available?: boolean; reason?: string } | null;
    placeholders?: { field?: string } | null;
    onFocusField?: unknown;
    canRemove: boolean;
    onReplace: (next: RuleRow) => void;
    onRemove: () => void;
    onUseExpression: () => void;
}

const RECORDS_OPS = new Set(['isEmpty', 'isNotEmpty', 'truthy']);

const fieldText = (row: RuleRow): string => String(
    (row.field?.kind === 'ref' ? row.field.path : row.field?.kind === 'expr' ? row.field.value : '') || '',
);

/** The last key of a path as written ("frm" for `item.frm`), or ''. */
function lastKey(path: string): string {
    const tokens = parsePath(path) as Array<{ type: string; key?: unknown }> | null;
    const last = tokens?.[tokens.length - 1];
    return last?.type === 'prop' && typeof last.key === 'string' ? last.key : '';
}

/** One entry of the list a quantified row checks, lower case: "attachment". */
export function entryName(listPath: string): string {
    const key = lastKey(listPath) || 'items';
    return String(humanizeFieldKey(singularKey(key)) || key).toLowerCase();
}

/** A field as the menu names it: its option's label, else its tail after `item`. */
function fieldLabel(path: string, options: FieldOption[] | null): string {
    const option = options?.find((o) => o.path === path);
    if (option?.label) return option.label;
    const tokens = parsePath(path) as Array<{ key?: unknown }> | null;
    const tail = tokens && tokens[0]?.key === 'item' && tokens.length > 1 ? formatPath(tokens.slice(1)) : path;
    return humanizeFieldTail(tail) || path;
}

/**
 * The field's name when the sample HAS the place it would be in but not the
 * field itself (R12): the parent object exists, or, for a column, the list
 * holds records none of which carries it. Null when there is no sample to tell.
 */
export function missingFieldName(path: string, sample: unknown): string | null {
    const shape = sample == null ? null : fieldShape(path) as { kind: string; path: string; list: string } | null;
    if (shape?.kind === 'column') return missingColumn(shape, sample);
    if (shape?.kind !== 'plain') return null;
    const tokens = parsePath(shape.path) as unknown[] | null;
    if (!tokens || tokens.length < 2) return null;
    const parent = getPath(sample, formatPath(tokens.slice(0, -1)));
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return null;
    return getPath(sample, shape.path) === undefined ? lastKey(shape.path) || null : null;
}

/** A column none of the list's records carries (the list read as the run reads it). */
function missingColumn(shape: { path: string; list: string }, sample: unknown): string | null {
    const list = getList(sample, shape.list) as unknown[] | null;
    if (!list || !list.some((el) => el && typeof el === 'object')) return null;
    const found = getPath(sample, shape.path);
    return Array.isArray(found) && found.length ? null : lastKey(shape.path) || null;
}

interface HintInput { row: RuleRow; type: string; previewSample: unknown; fieldOptions: FieldOption[] | null; context: string }

/** The notes under a row, in words (R9, R12, and a list path outside a quantifier). */
export function rowHints({ row, type, previewSample, fieldOptions, context }: HintInput, t: Translate): string[] {
    const path = row.field?.kind === 'ref' ? String(row.field.path || '') : '';
    const hints: string[] = [];
    if (path && type === 'records' && !RECORDS_OPS.has(row.op)) {
        hints.push(t('condition_node.hint.records_op',
            '{list} is a list, so “{op}” never matches it. Pick a field under {list} instead, for example File type.',
            { list: fieldLabel(path, fieldOptions), op: labelFor(row.op, type, t) }));
    }
    const missing = path ? missingFieldName(path, previewSample) : null;
    if (missing) {
        hints.push(t('condition_node.hint.field_missing',
            'There is no “{field}” in the sample data, so this rule would match nothing.', { field: missing }));
    }
    // Inside a list, a `[*]` path with no quantifier compares a whole list as one
    // value. In whole-run mode the editor's whole-list notice says this instead.
    if (context !== 'condition' && !row.quantifier && row.op !== 'truthy' && fieldText(row).includes('[*]')) {
        hints.push(t('condition_node.hint.list_field',
            'This field holds a list. Pick it from the field menu to check any, every or no item of it.'));
    }
    return hints;
}

export default function ConditionBuilderRow(props: Props) {
    const { row, previewSample, fieldOptions, simple, rawField, context, topics, canRemove, onReplace, onRemove } = props;
    const { t } = useTranslation();
    const type = rowType(row, previewSample, walkPath);
    const quantified = !!row.quantifier;
    const ops = operatorsForType(type, row.op, { topics: quantified ? null : topics, quantified, t });
    const shape = row.quantifier ? fieldShape(fieldText(row)) as { list?: string } | null : null;
    const hints = rowHints({ row, type, previewSample, fieldOptions, context }, t);
    const pickField = (field: Binding) => onReplace(rowForField(row, field, rowType({ field }, previewSample, walkPath)));
    return (
        // Below ~480px of room (a phone, a narrow pane) the three cells stack
        // instead of squeezing to "an" / "a…": small screens fold, never squeeze.
        // Below ~280px the quantifier and the field stack too.
        <div className="@container/rule">
            <div className="flex items-start gap-1.5">
                <div className="grid grid-cols-[1fr_auto_1fr] @max-[479px]/rule:grid-cols-1 gap-1.5 items-start flex-1 min-w-0">
                    <div className="flex items-start gap-1 min-w-0 @max-[279px]/rule:flex-col @max-[279px]/rule:items-stretch">
                        {row.quantifier && (
                            <QuantifierSelect
                                value={row.quantifier}
                                listName={entryName(shape?.list || '')}
                                onChange={(quantifier) => onReplace({ ...row, quantifier })}
                            />
                        )}
                        <div className="flex-1 min-w-0">
                            <RowField {...props} simple={simple} rawField={rawField} onPick={pickField} />
                        </div>
                    </div>
                    <select
                        value={row.op}
                        onChange={(e) => onReplace({ ...row, op: e.target.value })}
                        className={denseInputClass()}
                        title={`Field type: ${type}`}
                    >
                        {ops.map((o: { key: string; label: string; disabled?: boolean }) => (
                            <option key={o.key} value={o.key} disabled={o.disabled}>{o.label}</option>
                        ))}
                    </select>
                    <RowValue {...props} type={type} />
                </div>
                {canRemove && (
                    <button
                        type="button"
                        onClick={onRemove}
                        className="mt-1.5 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10"
                        title="Remove condition"
                    >
                        <Trash2 size={12} />
                    </button>
                )}
            </div>
            {hints.map((h) => <div key={h} className={`${AMBER_NOTE} mt-0.5`}>{h}</div>)}
        </div>
    );
}

/** The left side: a field picked by name, or (Advanced, no names) a path or expression. */
function RowField({ row, fieldOptions, fieldBase, simple, rawField, context, placeholders, previewSample, onFocusField, onPick, onUseExpression }:
    Props & { onPick: (field: Binding) => void }) {
    if (fieldOptions && (simple || !rawField)) {
        return (
            <FieldPicker
                value={row.field}
                onChange={onPick}
                options={fieldOptions}
                fallbackBase={fieldBase}
                onFocusField={onFocusField}
                onUseExpression={simple ? null : onUseExpression}
            />
        );
    }
    return (
        <BindingField
            placeholder={placeholders?.field || (context === 'filter' ? 'item.amount' : 'field (e.g. steps.step1.output.total)')}
            value={row.field}
            onChange={onPick}
            onFocusField={onFocusField}
            previewSample={previewSample}
            showExpressionHelp={false}
        />
    );
}

/** The right side: a file type, a topic, nothing (unary), or a typed value. */
function RowValue({ row, type, previewSample, onFocusField, onReplace }: Props & { type: string }) {
    if (isTopicOp(row.op)) {
        return <TopicValueSlot value={row.value} threshold={row.threshold} onChange={(patch: TopicRowPatch) => onReplace({ ...row, ...patch } as RuleRow)} />;
    }
    if (isUnaryOp(row.op)) return <div className="text-[10px] text-[var(--text-tertiary)] italic pt-1.5">no value needed</div>;
    if (type === 'fileType') return <FileTypeSelect value={row.value} onChange={(value) => onReplace({ ...row, value })} />;
    return (
        <ConditionValueSlot
            type={type}
            value={row.value}
            onChange={(value) => onReplace({ ...row, value })}
            onFocusField={onFocusField}
            previewSample={previewSample}
        />
    );
}
