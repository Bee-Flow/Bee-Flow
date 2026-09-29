import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppInputNumber from './AppInputNumber';
import AppForm from './AppForm';
import { RuntimeProvider, DEFAULT_RUNTIME, buildScope } from '../RuntimeContext';

/**
 * valueFrom on a number field (spec: input_number.valueFrom).
 *
 * Text and select could show the value the record already has; a number could
 * not — so a panel for correcting a thickness opened on an empty box next to
 * the thickness it was correcting.
 */

function renderNumber(props = {}, vars = {}) {
    const node = {
        id: 'cmp_n', type: 'input_number',
        props: { name: 'dikte_mm', label: 'Dikte', ...props },
        style: { span: 12 },
    };
    const formNode = {
        id: 'cmp_form', type: 'form', visible: true,
        props: { name: 'line', submitLabel: 'Save', showReset: false },
        style: { span: 12, gap: 3, padding: 0 },
        children: [node],
    };
    const scope = buildScope({ vars });
    return render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', scope }}>
            <AppForm node={formNode}><AppInputNumber node={node} /></AppForm>
        </RuntimeProvider>,
    );
}

describe('AppInputNumber — valueFrom', () => {
    it('opens on the value the record already has', () => {
        const { container } = renderNumber(
            { valueFrom: { kind: 'formula', expr: 'vars.regel.dikte_mm' } },
            { regel: { dikte_mm: 12 } },
        );
        expect(container.querySelector('input').value).toBe('12');
    });

    it('leaves the field alone when the binding resolves to nothing', () => {
        const { container } = renderNumber(
            { valueFrom: { kind: 'formula', expr: 'vars.regel.dikte_mm' }, defaultValue: 3 },
            { regel: { dikte_mm: null } },
        );
        expect(container.querySelector('input').value).toBe('3');
    });

    it('stays editable after the push', () => {
        const { container } = renderNumber(
            { valueFrom: { kind: 'formula', expr: 'vars.regel.dikte_mm' } },
            { regel: { dikte_mm: 12 } },
        );
        const input = container.querySelector('input');
        fireEvent.change(input, { target: { value: '8' } });
        expect(input.value).toBe('8');
    });
});
