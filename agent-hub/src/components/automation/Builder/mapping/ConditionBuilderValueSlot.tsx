import { Braces } from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import ValueBuilderJs from './ValueBuilder';
import { denseInputClass } from '../flow/settings/formStyles';
import { useTranslation } from '../../../../hooks/useTranslation';

// A JS component: TypeScript reads every prop without a default as required.
const ValueBuilder = ValueBuilderJs as unknown as ComponentType<Record<string, unknown>>;

export type Binding = { kind?: string; value?: unknown; path?: string } | null | undefined;
type LiteralBinding = { kind: 'literal'; value: unknown };

const slotInputClass = denseInputClass('w-full');

// conditionModel's inferred datatype → the plain-language kind the value
// editor names in its "expects" chrome and in a mismatch question. `array` is
// deliberately absent: the LEFT side may be a list, but every operator that
// accepts one (`contains`, `isEmpty`) still compares it against a single
// value, so claiming the slot wants a list would be a wrong claim.
const SLOT_KIND: Readonly<Record<string, string>> = Object.freeze({
    string: 'text', number: 'number', boolean: 'yesno', date: 'date',
});

interface Props {
    type: string;
    value: Binding;
    onChange: (next: Binding) => void;
    onFocusField?: unknown;
    previewSample?: unknown;
}

/**
 * Typed right-hand-side slot. When the LEFT field's inferred datatype is
 * known and the current value is a plain literal, render the matching
 * control (number / true-false / date) instead of a free-text field.
 * A small {} button swaps to the full value builder for variable values.
 * Storage stays a literal binding, so serialisation and the round trip are
 * unchanged.
 */
export default function ConditionValueSlot({ type, value, onChange, onFocusField, previewSample }: Props) {
    const { t } = useTranslation();
    const [useBinding, setUseBinding] = useState(false);
    const isLiteral = !value || value.kind == null || value.kind === 'literal';
    const typed = !useBinding && isLiteral && (type === 'number' || type === 'boolean' || type === 'date');

    if (!typed) {
        return (
            <ValueBuilder
                placeholder={t('automations.condition_builder_value_slot.value', 'value')}
                value={value}
                onChange={onChange}
                onFocusField={onFocusField}
                previewSample={previewSample}
                // Every operator this editor offers compares against ONE value
                // (there is no `is one of`, and `contains(left, right)` takes a
                // single needle), so a list dropped here is a question worth
                // asking, and the left field's type says what kind of value fits.
                expectShape="scalar"
                expectKind={SLOT_KIND[type] || null}
            />
        );
    }
    const v = value?.kind === 'literal' ? value.value : '';
    const swap = <SwapButton onClick={() => setUseBinding(true)} />;
    if (type === 'number') return <NumberSlot value={v} onChange={onChange} swap={swap} />;
    if (type === 'boolean') return <BooleanSlot value={v} onChange={onChange} swap={swap} />;
    return <DateSlot value={v} onChange={onChange} swap={swap} />;
}

function SwapButton({ onClick }: { onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onClick}
            title={t('automations.condition_builder_value_slot.use_a_variable_instead', 'Use a variable instead')}
            aria-label={t('automations.condition_builder_value_slot.use_a_variable_instead', 'Use a variable instead')}
            className="shrink-0 px-2 rounded border border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] flex items-center justify-center"
        >
            <Braces size={12} />
        </button>
    );
}

interface SlotProps {
    value: unknown;
    onChange: (next: LiteralBinding) => void;
    swap: ReactNode;
}

function NumberSlot({ value, onChange, swap }: SlotProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-stretch gap-1">
            <input
                type="number"
                value={value === '' || value == null ? '' : String(value)}
                onChange={(e) => onChange({ kind: 'literal', value: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder={t('automations.condition_builder_value_slot.number', 'number')}
                className={slotInputClass}
            />
            {swap}
        </div>
    );
}

function BooleanSlot({ value, onChange, swap }: SlotProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-stretch gap-1">
            <select
                value={value === true ? 'true' : value === false ? 'false' : ''}
                onChange={(e) => onChange({ kind: 'literal', value: e.target.value === '' ? '' : e.target.value === 'true' })}
                className={slotInputClass}
            >
                <option value="">{t('automations.condition_builder_value_slot.choose', '(choose)')}</option>
                <option value="true">true</option>
                <option value="false">false</option>
            </select>
            {swap}
        </div>
    );
}

/** An ISO date literal; a time picker when the saved value has a time. */
function DateSlot({ value, onChange, swap }: SlotProps) {
    const str = typeof value === 'string' ? value : '';
    // A time part sits at a fixed place in an ISO string: "YYYY-MM-DDTHH:MM".
    const hasTime = str.length >= 16 && str[10] === 'T' && str[13] === ':';
    return (
        <div className="flex items-stretch gap-1">
            <input
                type={hasTime ? 'datetime-local' : 'date'}
                value={hasTime ? str.slice(0, 16) : str.slice(0, 10)}
                onChange={(e) => onChange({ kind: 'literal', value: e.target.value })}
                className={slotInputClass}
            />
            {swap}
        </div>
    );
}
