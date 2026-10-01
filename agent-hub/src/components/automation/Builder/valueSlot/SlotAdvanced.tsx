import { useMemo, type ReactNode } from 'react';
import type { Slot } from '@shared/mapping/index.mjs';
import { useTranslation } from '../../../../hooks/useTranslation';
import BindingField from '../mapping/BindingField';
import type { FieldHandle } from './fieldHandle';
import { formulaInput, formulaOutput, type SlotStorage } from './slotModel';

/**
 * A value slot's Advanced › Formula: the formula editor (BindingField, with
 * its Text / Formula switch), where a value that is not one picked value is
 * written by hand, and where a stored binding the slot shows as a grey
 * "Formula" chip is edited, exactly as stored. The ways in are out of the
 * way and owned by the slot: the field's ⋯ › Formula (SlotMenu),
 * PickOptions › Advanced for a picked value, a click on the Formula chip.
 * `editing` is the slot's, so all three open the same editor. A picked or composed value is edited in its legacy spelling
 * (slotModel.formulaInput), never as JSON; one without such a spelling has
 * no Formula. A path slot (a config field holding a path string) edits its
 * path in Formula mode only (a Text-mode `{{ }}` is no path the runtime can
 * walk) and gets a string back.
 */
export interface SlotAdvancedProps {
    editing: boolean;
    onEditingChange: (editing: boolean) => void;
    value: unknown;
    onChange: (next: unknown) => void;
    storage: SlotStorage;
    label?: string | null;
    slot: Slot;
    expectKind?: string | null;
    hint?: ReactNode;
    required?: boolean;
    placeholder?: string;
    multiline?: boolean;
    previewSample?: object | null;
    onFocusField?: ((handle: FieldHandle) => void) | null;
}

// A path field holds the list (or value) itself: nothing is joined or taken from it.
const NATIVE_SLOT: Slot = { as: 'native' } as Slot;

export default function SlotAdvanced({
    editing, onEditingChange, value, onChange, storage, label = null, slot, expectKind = null, hint = null,
    required = false, placeholder = '', multiline = false, previewSample = null, onFocusField = null,
}: SlotAdvancedProps) {
    const { t } = useTranslation();
    // Stable per stored value: BindingField resets its text whenever `value` changes.
    const input = useMemo(() => formulaInput(value, storage, previewSample), [value, storage, previewSample]);
    if (!input || !editing) return null;
    const path = storage === 'path';
    return (
        <div className="space-y-1" data-testid="slot-formula">
            <BindingField
                value={input.value}
                onChange={(b) => onChange(formulaOutput(b, storage))}
                formulaOnly={path}
                label={label}
                hideLabel
                hint={hint}
                required={required}
                placeholder={placeholder}
                multiline={multiline}
                expectKind={expectKind}
                slot={path ? NATIVE_SLOT : slot}
                previewSample={previewSample}
                onFocusField={onFocusField}
            />
            <button
                type="button"
                onClick={() => onEditingChange(false)}
                className="text-[10px] text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
            >
                {t('routines.builder.back_to_simple', 'Back to the simple editor')}
            </button>
        </div>
    );
}
