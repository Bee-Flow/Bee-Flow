import { FunctionSquare, Pencil, Type, Undo2 } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import Toggle from '../../../../shared/Toggle';
import { RepeatableList } from '../../../product-website/fields';
import ExpressionInput from '../inspector/logic/ExpressionInput';
import { INPUT_CLS } from '../inspector/panels/kit';
import type { AppDefinition, AppNode } from '../inspector/appDefinition';
import type { FormulaValue, FilterValue, Stash, FilterRow, FilterField, FilterRowsEditorProps } from './FilterRowsEditor.types';
import { logger } from '../../../../../utils/logger';
import { allowedOps, opsFor, isFormulaValue, choicesOf, valueControlFor, isNumeric, emptyValueFor } from './FilterRowsEditor.helpers';
import { ValueControl } from './ValueControl';
export type { FilterRow } from './FilterRowsEditor.types';

export const NO_VALUE_OPS = new Set(['isNull', 'isNotNull']);

// Ops whose value is a LIST, not a scalar (queryCompiler: `in` takes an array,
// `between` a [min, max] pair).
const LIST_OPS = new Set(['in', 'between']);

// Controls whose value is a SHAPE (an array, a pair) rather than a scalar, so
// the raw-text escape cannot represent them without corrupting the filter.
const SHAPE_CONTROLS = new Set(['list', 'range']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Can the typed control show `value` faithfully? A `false` here is what drops
 * the row to free text, so the user always SEES what is saved even when the
 * pretty control cannot express it.
 */
function isRepresentable(value: FilterValue, control: string, field: FilterField | null) {
    if (value === '' || value == null) return true;
    switch (control) {
        case 'bool': return value === true || value === false;
        case 'choice': return choicesOf(field).some((c) => c.value === String(value));
        case 'date': return DATE_RE.test(String(value));
        case 'datetime': return DATETIME_RE.test(String(value));
        case 'number': return isNumeric(value);
        case 'list': return Array.isArray(value);
        case 'range': return Array.isArray(value) && value.length === 2;
        default: return true;
    }
}

/**
 * A literal, written as the expression that yields it — `open` → `"open"`.
 *
 * Switching Literal→Formula used to write an empty expression over whatever was
 * there. Carrying the value across means the toggle is a way to LOOK at the
 * value as a formula, which is how someone learns the syntax; it also means a
 * misclick costs nothing. Arrays are the one thing that cannot come along: the
 * expression grammar has no array literal (`[` is index access), so `in` and
 * `between` rows fall back to the remembered value instead.
 */
function exprFromLiteral(value: FilterValue) {
    if (typeof value === 'string') return value === '' ? '' : JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    return '';
}

/** The inverse, for the expressions simple enough to be a literal again. */
function literalFromExpr(expr: string | undefined, control: string) {
    const src = typeof expr === 'string' ? expr.trim() : '';
    if (!src) return emptyValueFor(control);
    if (src === 'true') return true;
    if (src === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(src)) return control === 'number' ? src : Number(src);
    if (/^"([^"\\]|\\.)*"$/.test(src) || /^'([^'\\]|\\.)*'$/.test(src)) {
        try { return JSON.parse(`"${src.slice(1, -1).replace(/"/g, '\\"')}"`); } catch (err) { logger.debug('string literal not parseable, fall through to raw expression', err); }
    }
    return emptyValueFor(control);
}

export default function FilterRowsEditor({
    fields = [],
    filters,
    onChange,
    allowFormula = false,
    label,
    disabled = false,
    definition = null,
    node = null,
}: FilterRowsEditorProps) {
    const { t } = useTranslation();
    const fieldName = (key: string) => (fields.find((f) => f.key === key) || {}).name || key || t('studio_apps_bi.filter.filter', 'Filter');
    // Rows the user explicitly sent to free text, keyed by the row OBJECT.
    // Never by index: RepeatableList re-indexes on remove.
    const [escaped, setEscaped] = useState(() => new Set<FilterRow>());
    // What the OTHER mode held, per row object. Literal↔Formula is a two-way
    // door: the value you came from is waiting when you go back, even for the
    // shapes (a list, a range) that cannot be written as an expression at all.
    const [stashed, setStashed] = useState(() => new Map<FilterRow, Stash | undefined>());

    const rows = Array.isArray(filters) ? filters : [];

    /**
     * Move the marker from the row object being replaced onto its replacement,
     * and forget rows that no longer exist. A row that was NOT escaped must
     * stay unescaped — carrying the marker onto every edited row would send the
     * whole list to free text after one keystroke.
     */
    const reKey = (from: FilterRow, to: FilterRow) => {
        setEscaped((prev) => {
            if (!prev.has(from)) {
                const live = new Set(rows.filter((row) => prev.has(row)));
                return live.size === prev.size ? prev : live;   // same set → no re-render
            }
            const next = new Set<FilterRow>();
            for (const row of rows) {
                if (row === from) next.add(to);
                else if (prev.has(row)) next.add(row);
            }
            return next;
        });
        setStashed((prev) => {
            if (prev.size === 0) return prev;
            const next = new Map<FilterRow, Stash | undefined>();
            for (const row of rows) {
                if (row === from) { if (prev.has(from)) next.set(to, prev.get(from)); }
                else if (prev.has(row)) next.set(row, prev.get(row));
            }
            return next.size === prev.size && !prev.has(from) ? prev : next;
        });
    };

    return (
        <fieldset disabled={disabled} className="min-w-0">
            <RepeatableList
                label={label ?? t('studio_apps_bi.filter.filters', 'Filters')}
                items={rows}
                onChange={onChange}
                makeNew={() => ({ field: '', op: 'eq', value: '' })}
                addLabel={t('studio_apps_bi.filter.add', 'Add filter')}
                itemLabel={(f) => fieldName(f.field)}
                renderItem={(f, rawUpdate, idx) => {
                    // Every write goes through here so the free-text marker
                    // follows the row object rather than its position.
                    const update = (next: FilterRow) => { reKey(f, next); rawUpdate(next); };

                    const usesFormula = isFormulaValue(f.value);
                    const needsValue = !NO_VALUE_OPS.has(f.op);
                    const field = fields.find((x) => x.key === f.field) || null;
                    const typedControl = valueControlFor(field, f.op);
                    // Derived first, remembered second: a saved value the typed
                    // control cannot show must never be hidden behind an empty
                    // widget the next click overwrites.
                    // The list control renders ANY saved value (it splits a
                    // string on commas), so it never needs the raw-text
                    // fallback — and taking it would write a string back into a
                    // field that must hold an array.
                    const unrepresentable = !usesFormula
                        && typedControl !== 'list'
                        && !isRepresentable(f.value, typedControl, field);
                    const isEscaped = escaped.has(f);
                    const control = (isEscaped || unrepresentable) ? 'text' : typedControl;
                    // The raw-text escape exists for controls that CONSTRAIN a
                    // value (a choice list, a date, yes/no). It cannot be
                    // offered for the ones that carry a SHAPE: "is one of" takes
                    // an array and "is between" a pair, and the text box wrote a
                    // plain string into both — which the compiler then matched
                    // zero rows against, in silence. Their own controls already
                    // accept free text anyway.
                    const canEscape = typedControl !== 'text' && !SHAPE_CONTROLS.has(typedControl);

                    const toggleEscape = () => {
                        if (isEscaped) {
                            // Back to the picker: clear only if what is there
                            // cannot be shown, so a valid value survives.
                            setEscaped((prev) => { const n = new Set(prev); n.delete(f); return n; });
                            if (!isRepresentable(f.value, typedControl, field)) {
                                rawUpdate({ ...f, value: emptyValueFor(typedControl) });
                            }
                            return;
                        }
                        setEscaped((prev) => new Set(prev).add(f));
                    };

                    /**
                     * Literal ↔ Formula, carrying the value across.
                     *
                     * This used to write '' over whatever was in the box, so one
                     * click on the wrong icon lost a hand-written expression and
                     * the only way back was the editor-wide undo, which is not
                     * anywhere near these buttons.
                     */
                    const toggleFormula = () => {
                        const remembered = stashed.get(f) || {};
                        const nextValue = usesFormula
                            ? (remembered.literal !== undefined
                                ? remembered.literal
                                : literalFromExpr((f.value as FormulaValue)?.expr, typedControl))
                            : { kind: 'formula', expr: remembered.formula || exprFromLiteral(f.value) };
                        const leaving = usesFormula
                            ? { formula: (f.value as FormulaValue)?.expr ?? '' }
                            : { literal: f.value };
                        setStashed((prev) => new Map(prev).set(f, { ...remembered, ...leaving }));
                        update({ ...f, value: nextValue });
                    };

                    return (
                        <div className="flex flex-col gap-2">
                            <div className="grid grid-cols-2 gap-2">
                                <select
                                    className={INPUT_CLS}
                                    value={f.field || ''}
                                    onChange={(e) => {
                                        const nextField = fields.find((x) => x.key === e.target.value) || null;
                                        // An op the new column cannot carry is
                                        // reset rather than left behind — a
                                        // stale `contains` on a yes/no column
                                        // rendered a free-text box.
                                        const op = allowedOps(nextField).includes(f.op) ? f.op : 'eq';
                                        const nextControl = valueControlFor(nextField, op);
                                        update({
                                            ...f,
                                            field: e.target.value,
                                            op,
                                            ...(usesFormula ? {} : { value: emptyValueFor(nextControl) }),
                                        });
                                    }}
                                    aria-label={t('studio_apps_bi.filter.field', 'Filter field')}
                                >
                                    <option value="">{t('studio_apps_bi.filter.pick_field', 'Pick a field…')}</option>
                                    {fields.map((x) => <option key={x.key} value={x.key}>{x.name || x.key}</option>)}
                                </select>
                                <select
                                    className={INPUT_CLS}
                                    value={f.op || 'eq'}
                                    onChange={(e) => {
                                        const op = e.target.value;
                                        const nextControl = valueControlFor(field, op);
                                        // A scalar cannot stand in for the
                                        // [min,max] `between` wants, nor for
                                        // the array `in` wants.
                                        const shapeChanged = LIST_OPS.has(op) !== LIST_OPS.has(f.op)
                                            || (op === 'between') !== (f.op === 'between');
                                        update({
                                            ...f,
                                            op,
                                            ...(usesFormula || !shapeChanged ? {} : { value: emptyValueFor(nextControl) }),
                                        });
                                    }}
                                    aria-label={t('studio_apps_bi.filter.operator', 'Filter operator')}
                                >
                                    {opsFor(field, f.op, t).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                            </div>
                            {needsValue ? (
                                <div className="flex items-stretch gap-1.5">
                                    {usesFormula ? (
                                        <div className="min-w-0 flex-1">
                                            <ExpressionInput
                                                variant="inline"
                                                value={(f.value as FormulaValue)?.expr ?? ''}
                                                onChange={(expr) => update({ ...f, value: { kind: 'formula', expr } })}
                                                definition={definition}
                                                node={node}
                                                placeholder={t('studio_apps_bi.filter.formula_placeholder', 'e.g. currentUser.id')}
                                                ariaLabel={t('studio_apps_bi.filter.formula', 'Filter formula')}
                                                showPicker={!!definition}
                                            />
                                        </div>
                                    ) : (
                                        <div className="min-w-0 flex-1">
                                            <ValueControl control={control} f={f} field={field} update={update} />
                                        </div>
                                    )}
                                    {!usesFormula && canEscape ? (
                                        <button
                                            type="button"
                                            onClick={toggleEscape}
                                            title={control === 'text' ? t('studio_apps_bi.filter.back_to_picker', 'Back to the simple picker') : t('studio_apps_bi.filter.type_any', 'Type any value')}
                                            aria-label={control === 'text' ? t('studio_apps_bi.filter.back_to_picker', 'Back to the simple picker') : t('studio_apps_bi.filter.type_any', 'Type any value')}
                                            className="shrink-0 px-2 rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                                        >
                                            {control === 'text' ? <Undo2 size={13} /> : <Pencil size={13} />}
                                        </button>
                                    ) : null}
                                    {allowFormula ? (
                                        <button
                                            type="button"
                                            onClick={toggleFormula}
                                            title={usesFormula ? t('studio_apps_bi.filter.use_fixed', 'Use a fixed value') : t('studio_apps_bi.filter.use_formula', 'Use a formula')}
                                            aria-label={usesFormula ? t('studio_apps_bi.filter.use_fixed', 'Use a fixed value') : t('studio_apps_bi.filter.use_formula', 'Use a formula')}
                                            className="shrink-0 px-2 rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                                        >
                                            {usesFormula ? <Type size={13} /> : <FunctionSquare size={13} />}
                                        </button>
                                    ) : null}
                                </div>
                            ) : null}

                            {/*
                              * The server has honoured `required` all along and
                              * nothing wrote it. Without it, a scoping filter
                              * whose formula does not resolve is DROPPED and the
                              * component lists the whole table — the "quietly
                              * showing the wrong rows" failure. Offered only
                              * where a value can fail to resolve.
                              */}
                            {allowFormula && needsValue ? (
                                <Toggle
                                    size="sm"
                                    label={t('studio_apps_bi.filter.required_label', 'Show nothing until this has a value')}
                                    description={t('studio_apps_bi.filter.required_desc', 'Otherwise an unset value means “no filter”, and every row shows.')}
                                    checked={!!f.required}
                                    onChange={(v) => {
                                        const { required: _drop, ...rest } = f;
                                        update(v ? { ...rest, required: true } : rest);
                                    }}
                                    ariaLabel={t('studio_apps_bi.filter.required_aria', 'Filter {n} required', { n: idx + 1 })}
                                />
                            ) : null}
                        </div>
                    );
                }}
            />
        </fieldset>
    );
}
