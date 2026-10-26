import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import PathField from '../../mapping/PathField';
import { cardClass, FormRow, rowInputClass } from './formPrimitives';
import { INLINE_LINK } from './formStyles';
import type { RouteRule } from './routeEditorsModel';

/**
 * Case-name input that commits on blur/Enter instead of per keystroke.
 *
 * Live-controlled names fed the 600ms autosave half-typed states: a
 * select-all-and-retype passed through `''`, which buildPatch filters out of
 * `patch.cases`, which the edge reconcile then read as "case removed" — and
 * the case's canvas connection was dropped mid-typing (node-audit C1/B1a).
 * Committing only a valid final name means `draft.cases` never holds an
 * empty or duplicate name, so every flushed patch is either a clean rename
 * or an explicit trash-click removal.
 *
 * The placeholder used to read "case name (becomes the port label)" in a
 * monospace field — the last piece of raw jargon left on a beginner's main
 * path through this node, now that the mode override, the source path and the
 * compiled expression have all moved under Advanced. "Case" and "port" are
 * words from the runtime step types (routeModel.js keeps them because every
 * saved automation speaks them); nobody typing "invoices" here has met either,
 * and the monospace face said "this is code" about a field that takes plain
 * words. The name still becomes the port label — that is explained in the
 * lines beside the field, in the section that says what happens to a wired
 * output when it is renamed.
 */
function CaseNameInput({ name, siblingNames = [], onCommit }: { name: string; siblingNames?: string[]; onCommit: (name: string) => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState(name);
    const [error, setError] = useState<string | null>(null);
    // Resync when the committed name changes underneath us (AI patch / undo).
    useEffect(() => { setText(name); setError(null); }, [name]);

    const commit = () => {
        const trimmed = String(text || '').trim();
        if (trimmed === name) { setText(name); setError(null); return; }
        if (!trimmed) {
            setText(name);
            setError('Name required — reverted.');
            return;
        }
        if (siblingNames.includes(trimmed)) {
            setError(`A case named “${trimmed}” already exists.`);
            return;
        }
        setError(null);
        onCommit(trimmed);
    };

    return (
        <div className="flex-1 min-w-0">
            <input
                type="text"
                value={text}
                onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                placeholder={t('automations.route_editors.name_this_output_for_example_invoices', 'Name this output — for example invoices')}
                aria-invalid={!!error}
                className={rowInputClass('w-full', { invalid: !!error })}
            />
            {error && <div className="mt-0.5 text-[10px] text-red-500">{error}</div>}
        </div>
    );
}

/**
 * Typed "value to match" input for a switch case. When the switch expression's
 * datatype is known, render the matching control (number / boolean); otherwise
 * fall back to free text. Storage stays a plain string/number/boolean so the
 * runtime's loose-equality match is unchanged.
 */
function CaseValueInput({ type, value, onChange }: { type: string; value: unknown; onChange: (value: string | number | boolean) => void }) {
    const { t } = useTranslation();
    if (type === 'number') {
        return (
            <input
                type="number"
                value={typeof value === 'number' || typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder={t('automations.route_editors.number_to_match', 'number to match')}
                className={rowInputClass('w-full')}
            />
        );
    }
    if (type === 'boolean') {
        return (
            <select
                value={value === true ? 'true' : value === false ? 'false' : ''}
                onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'true')}
                className={rowInputClass('w-full')}
            >
                <option value="">{t('automations.route_editors.choose', '(choose)')}</option>
                <option value="true">{t('automations.route_editors.true', 'true')}</option>
                <option value="false">{t('automations.route_editors.false', 'false')}</option>
            </select>
        );
    }
    return (
        <input
            type="text"
            value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t('automations.route_editors.value_to_match', 'value to match')}
            className={rowInputClass('w-full')}
        />
    );
}

type PathFieldProps = ComponentProps<typeof PathField>;

interface ValueToCheckProps {
    matchOn: string;
    onChange: (next: string) => void;
    onConvert: () => void;
    onFocusField: PathFieldProps['onFocusField'];
    previewSample: PathFieldProps['previewSample'];
}

/** The legacy value-style switch's "Value to check" row, with the one-click way out of that shape. */
export function RouteValueToCheck({ matchOn, onChange, onConvert, onFocusField, previewSample }: ValueToCheckProps) {
    const { t } = useTranslation();
    return (
        <FormRow label={t('automations.route_editors.value_to_check', 'Value to check')} hint={t('automations.route_editors.picked_once_matched_against_each_rule', 'Picked once; matched against each rule\'s value below.')}>
            <div className="space-y-1">
                <PathField
                    // PathField's JS signature lists `label` without a default; the row carries its own.
                    label={undefined}
                    value={matchOn}
                    onChange={onChange}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder="trigger.output.value"
                />
                <button
                    type="button"
                    onClick={onConvert}
                    className={`text-[10px] ${INLINE_LINK}`}
                >
                    {t('automations.route_editors.use_full_conditions_instead', 'Use full conditions instead')}
                </button>
            </div>
        </FormRow>
    );
}

interface RuleListProps {
    rules: RouteRule[];
    several: boolean;
    fanOut: boolean;
    items: boolean;
    keepRest: boolean;
    valueStyle: boolean;
    wiredCaseNames: Set<string> | null;
    outputName: (i: number) => string;
    onUpdate: (i: number, patch: Partial<RouteRule>) => void;
    onMove: (i: number, dir: number) => void;
    onRemove: (i: number) => void;
    onAdd: () => void;
    /** The condition builder for one rule, already scoped to the current item. */
    renderCondition: (i: number, rule: RouteRule) => ReactNode;
}

/** The "Conditions per output" rows: one condition set per output, with name, order and remove controls once there are several. */
export function RouteRuleList({
    rules, several, fanOut, items, keepRest, valueStyle, wiredCaseNames, outputName, onUpdate, onMove, onRemove, onAdd, renderCondition,
}: RuleListProps) {
    const { t } = useTranslation();
    // A rule only needs a NAME when it becomes a labelled port — with a single
    // rule there is nothing to label, so the field would have no visible effect.
    const namesMatter = rules.length > 1;
    return (
        <FormRow
            label={several ? 'Conditions per output' : (items ? 'Keep when' : 'Continue when')}
            hint={several
                ? (fanOut
                    ? `Each output has its own condition set and is checked independently — ${items ? 'an item' : 'a record'} can match several.`
                    : `Each output has its own condition set, checked in order — the first match wins.`)
                : (items
                    ? (keepRest
                        ? t('condition_node.otherwise.one_keep', 'What matches continues; what doesn\'t goes to “Otherwise”; leave “Otherwise” unconnected to drop it.')
                        : 'Every item is checked against this condition. Items that do not match stop here.')
                    : 'The run continues when this is true.')}
        >
            <div className="space-y-2">
                {rules.length === 0 && (
                    <div className="text-[11px] text-[var(--text-tertiary)] italic">{t('automations.route_editors.no_outputs_yet_add_one', 'No outputs yet — add one.')}</div>
                )}
                {rules.map((r, i) => (
                    <div key={i} className={namesMatter ? cardClass() : ''}>
                        {namesMatter && (
                            <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
                                {outputName(i)}
                            </div>
                        )}
                        {namesMatter && (
                            <div className="flex items-center gap-1.5">
                                <CaseNameInput
                                    name={r.name || ''}
                                    siblingNames={rules.filter((_, j) => j !== i).map(x => x?.name).filter(Boolean)}
                                    onCommit={(name) => onUpdate(i, { name })}
                                />
                                <button
                                    type="button"
                                    onClick={() => onMove(i, -1)}
                                    disabled={i === 0}
                                    aria-label={t('automations.route_editors.move_output_up', 'Move output up')}
                                    title={t('automations.route_editors.move_output_up', 'Move output up')}
                                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <ArrowUp size={12} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onMove(i, 1)}
                                    disabled={i === rules.length - 1}
                                    aria-label={t('automations.route_editors.move_output_down', 'Move output down')}
                                    title={t('automations.route_editors.move_output_down', 'Move output down')}
                                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <ArrowDown size={12} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onRemove(i)}
                                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10"
                                    title={wiredCaseNames?.has?.(r.name)
                                        ? 'Remove output — its canvas connection will be removed too'
                                        : 'Remove output'}
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        )}
                        {namesMatter && wiredCaseNames?.has?.(r.name) && (
                            <div className="text-[10px] text-[var(--text-tertiary)]">
                                {t('automations.route_editors.wired_on_the_canvas_renaming_keeps', 'Wired on the canvas — renaming keeps the connection; removing drops it.')}
                            </div>
                        )}
                        {valueStyle
                            ? <CaseValueInput type="unknown" value={r.value} onChange={(v) => onUpdate(i, { value: v })} />
                            : renderCondition(i, r)}
                    </div>
                ))}
                <button
                    type="button"
                    onClick={onAdd}
                    title={t('automations.route_editors.each_output_gets_its_own_condition', 'Each output gets its own condition set and its own port on the node')}
                    className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] px-2 py-1 rounded transition"
                >
                    <Plus size={12} /> {t('automations.route_editors.add_output', 'Add output')}
                </button>
                <div className="text-[10px] text-[var(--text-tertiary)]">
                    {t('automations.route_editors.text_comparisons_ignore_upper_lower_case', 'Text comparisons ignore upper/lower case.')}
                </div>
            </div>
        </FormRow>
    );
}
