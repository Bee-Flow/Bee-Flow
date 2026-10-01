import type { ComponentType } from 'react';
import { EnumChoice, FrequentValues, ProblemNote, SuggestionChip, type ParamSuggestion } from './ParamExtras';
import { describeExample, isMultilineProp, paramLabel, shortEnum, type SchemaProp } from './toolInputHelpers';
import ValueSlot from '../../valueSlot/ValueSlot';
import type { FieldHandle } from '../../valueSlot/fieldHandle';
import BindingField from '../BindingField';
import { FieldLabelRow as FieldLabelRowJs } from '../fieldChrome';
import { expectedKindFor } from '../fieldKinds';
import { isEmptyBinding } from '../partitionInputs';

// The label row is untyped JS; its props are checked there.
const FieldLabelRow = FieldLabelRowJs as unknown as ComponentType<Record<string, unknown>>;
const isEmpty = isEmptyBinding as (b: unknown) => boolean;
const kindOf = expectedKindFor as (p: unknown) => string;

/**
 * The value slot's placeholder: the schema's own example (or default), else
 * the slot's "Type a value, or pick one from Comes in". Never the type
 * shorthand the formula editor uses ("[…]", "{…}", "true / false").
 */
function slotExample(prop: SchemaProp | undefined): string | null {
    const example = prop?.example ?? prop?.default;
    return example != null && typeof example !== 'object' && String(example).trim() ? String(example) : null;
}

/** Kinds a "Frequently used" chip can fill: one plain value. */
const FREQUENT_KINDS = new Set(['text', 'email', 'number', 'date', 'choice']);

/**
 * One schema-declared setting in "What this step does" (round 4): the value
 * editor it always had, plus what the artboards add around it. A short enum
 * becomes buttons with "recommended" on the schema default, an empty
 * required setting gets a one-click suggestion, an empty plain setting the
 * values this organisation uses most, and the setting the last run's error
 * named gets the red ring with the problem under it.
 */
export default function ToolParamField({
    fieldKey, prop, required, value, onChange, visual, allowRaw, onFocusField, previewSample,
    autoMapped, suggestion = null, tool = null, problem = null,
}: {
    fieldKey: string;
    prop: SchemaProp | undefined;
    required: boolean;
    value: unknown;
    onChange: (binding: unknown) => void;
    visual: boolean;
    allowRaw: boolean;
    onFocusField?: ((handle: FieldHandle) => void) | null;
    previewSample?: object | null;
    autoMapped: boolean;
    suggestion?: ParamSuggestion | null;
    tool?: string | null;
    problem?: string | null;
}) {
    // A person's name for the setting: its title, else a short description,
    // else the key made readable ("To", not `to`).
    const label = paramLabel(fieldKey, prop);
    const empty = isEmpty(value);
    const expectKind = kindOf(prop);
    const options = shortEnum(prop);
    const literal = value && typeof value === 'object' && (value as { kind?: string }).kind === 'literal'
        ? String((value as { value?: unknown }).value ?? '')
        : null;
    const asButtons = !!options && (empty || (literal != null && options.includes(literal)));
    const recommended = prop?.default != null && options?.includes(String(prop.default)) ? String(prop.default) : null;
    const setLiteral = (v: string) => onChange({ kind: 'literal', value: v });

    let editor;
    if (asButtons && options) {
        editor = (
            <div className="space-y-1.5">
                <FieldLabelRow label={label} required={required} hint={prop?.description} autoMapped={autoMapped} />
                <EnumChoice options={options} value={literal} recommended={recommended} onPick={setLiteral} label={label} />
            </div>
        );
    } else if (visual) {
        editor = (
            <ValueSlot
                label={label}
                fieldId={fieldKey}
                field={fieldKey}
                schema={prop}
                showChrome
                hint={prop?.description}
                required={required}
                placeholder={slotExample(prop)}
                value={value ?? null}
                onChange={onChange}
                onFocusField={onFocusField}
                previewSample={previewSample}
                multiLine={isMultilineProp(prop)}
                autoMapped={autoMapped}
                allowRaw={allowRaw}
                expectKind={expectKind}
            />
        );
    } else {
        editor = (
            <BindingField
                label={label}
                hint={prop?.description}
                required={required}
                placeholder={describeExample(prop)}
                value={value ?? null}
                onChange={onChange}
                onFocusField={onFocusField}
                previewSample={previewSample}
                multiline={isMultilineProp(prop)}
                autoMapped={autoMapped}
                expectKind={expectKind}
            />
        );
    }

    return (
        <div
            data-testid={`param-${fieldKey}`}
            data-problem={problem ? 'true' : undefined}
            className={`space-y-1.5 ${problem
                ? 'rounded-lg p-2 -m-2 border-[1.5px] border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_5%,transparent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--error)_14%,transparent)]'
                : ''}`}
        >
            {editor}
            {problem && <ProblemNote text={problem} />}
            {required && empty && suggestion && <SuggestionChip suggestion={suggestion} onUse={() => onChange(suggestion.binding)} />}
            {empty && tool && !asButtons && FREQUENT_KINDS.has(expectKind) && (
                <FrequentValues tool={tool} input={fieldKey} onPick={setLiteral} />
            )}
        </div>
    );
}
