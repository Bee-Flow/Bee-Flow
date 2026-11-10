import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StepField } from './StepField';
import { BUILT_IN_FIELD_TYPES, buildFieldControls, fieldControlFor } from './fieldTypes';
import type { StepFieldControlProps, StepFieldTypeModule } from './fieldTypes';
import type { StepFieldProps } from '../StepSettings.types';

/** A fixture control, never shipped: what a file under fieldTypes/ exports. */
function ShoutControl({ label, hint, required, value, onChange, disabled }: StepFieldControlProps) {
    return (
        <label>
            {label}{required ? ' *' : ''}
            <input aria-label={label} value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value.toUpperCase())} />
            {hint ? <span>{hint}</span> : null}
        </label>
    );
}
const shout: StepFieldTypeModule = { type: 'zzShout', Control: ShoutControl };

const baseProps: StepFieldProps = {
    fieldKey: 'banner', fs: { type: 'zzShout', required: true }, value: 'a', step: { kind: 'zz_probe' } as StepFieldProps['step'], onChange: () => {},
    definition: {} as StepFieldProps['definition'], node: null, options: {}, references: {} as StepFieldProps['references'], formFields: [], disabled: false,
};

describe('step field types: a control is one file', () => {
    it('maps a type to the control its file exports', () => {
        const controls = buildFieldControls({ './fieldTypes/zzShout.tsx': { default: shout } });
        expect(fieldControlFor('zzShout', controls)).toBe(ShoutControl);
        expect(fieldControlFor('string', controls)).toBe(null);
        expect(fieldControlFor('constructor', controls)).toBe(null);
    });

    it('refuses a file that names a built-in type or not its own type', () => {
        for (const type of BUILT_IN_FIELD_TYPES) {
            expect(() => buildFieldControls({ [`./fieldTypes/${type}.tsx`]: { default: { type, Control: ShoutControl } } })).toThrow(/built-in/);
        }
        expect(() => buildFieldControls({ './fieldTypes/other.tsx': { default: shout } })).toThrow(/its own type/);
    });

    it('ships a control for each structured step field type, and none that takes over a built-in', () => {
        expect(fieldControlFor('zzShout')).toBe(null);
        for (const type of BUILT_IN_FIELD_TYPES) expect(fieldControlFor(type)).toBe(null);
        for (const type of ['aiSchema', 'aiWriteTo', 'contextSources', 'stringList', 'approvalStages', 'approvalQuestions', 'approvalOnDecided', 'number', 'aiChecks']) {
            expect(typeof fieldControlFor(type)).toBe('function');
        }
    });

    it('StepField draws the registered control for its type, with the label it worked out', async () => {
        const onChange = vi.fn();
        render(<StepField {...baseProps} onChange={onChange} fieldControls={{ zzShout: ShoutControl }} />);
        const input = screen.getByLabelText('Banner');
        expect(screen.getByText(/Banner \*/)).toBeTruthy();
        await userEvent.type(input, 'b');
        expect(onChange).toHaveBeenCalledWith('AB');
    });

    it('StepField falls back to its own text input for a type nobody registered', () => {
        render(<StepField {...baseProps} />);
        expect((screen.getByLabelText('Banner') as HTMLInputElement).type).toBe('text');
    });
});
