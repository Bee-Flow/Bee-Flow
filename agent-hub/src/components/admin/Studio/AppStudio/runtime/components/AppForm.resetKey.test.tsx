import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppForm from './AppForm';
import AppInputNumber from './AppInputNumber';
import AppInputText from './AppInputText';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import type { ComponentProps } from 'react';
import { omitted, stub } from '@/test/mocks';
import userEvent from '@testing-library/user-event';

/**
 * form.resetKey — a form that edits ONE selected record.
 *
 * valueFrom never pushes null (on purpose: an unresolved binding must not wipe
 * what the user typed). For a record editor that rule has a sharp edge: pick
 * row A (thickness 12), then row B (thickness empty) — the field still shows
 * 12, and Save writes A's thickness onto B. Keying the form on the selection
 * remounts it, so every field starts over from the new row.
 */

function Harness({ vars, resetKey }: { vars?: unknown; resetKey?: unknown }) {
    const node = {
        id: 'cmp_form', type: 'form', visible: true,
        props: { name: 'edit', submitLabel: 'Save', showReset: false, showSubmit: false, resetKey },
        style: { span: 12, gap: 3, padding: 0 },
        children: [],
    };
    const dikte = {
        id: 'cmp_d', type: 'input_number',
        props: { name: 'dikte_mm', label: 'Dikte', valueFrom: { kind: 'formula', expr: 'vars.regel.dikte_mm' } },
        style: { span: 6 },
    };
    const mat = {
        id: 'cmp_m', type: 'input_text',
        props: { name: 'materiaal', label: 'Materiaal', valueFrom: { kind: 'formula', expr: 'vars.regel.materiaal' } },
        style: { span: 6 },
    };
    const scope = buildScope(stub<Parameters<typeof buildScope>[0]>({ vars }));
    return (
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', scope }}>
            <AppForm node={node}>
                <AppInputNumber node={stub<ComponentProps<typeof AppInputNumber>['node']>(dikte)} />
                <AppInputText node={stub<ComponentProps<typeof AppInputText>['node']>(mat)} />
            </AppForm>
        </RuntimeProvider>
    );
}

const A = { id: 'a', dikte_mm: 12, materiaal: 'RVS' };
const B = { id: 'b', dikte_mm: null, materiaal: null };

describe('AppForm — resetKey', () => {
    it('without a resetKey the previous row leaks into an empty field (the bug this exists for)', () => {
        const { container, rerender } = render(<Harness {...omitted<ComponentProps<typeof Harness>>()} vars={{ regel: A }} />);
        expect((container.querySelector('input[name="dikte_mm"]') as HTMLInputElement).value).toBe('12');
        rerender(<Harness {...omitted<ComponentProps<typeof Harness>>()} vars={{ regel: B }} />);
        // Documented, not desired: null never pushes, so 12 stays.
        expect((container.querySelector('input[name="dikte_mm"]') as HTMLInputElement).value).toBe('12');
    });

    it('with a resetKey a new selection starts the form over', () => {
        const { container, rerender } = render(<Harness vars={{ regel: A }} resetKey="vars.regel.id" />);
        expect((container.querySelector('input[name="dikte_mm"]') as HTMLInputElement).value).toBe('12');
        expect((container.querySelector('input[name="materiaal"]') as HTMLInputElement).value).toBe('RVS');
        rerender(<Harness vars={{ regel: B }} resetKey="vars.regel.id" />);
        expect((container.querySelector('input[name="dikte_mm"]') as HTMLInputElement).value).toBe('');
        expect((container.querySelector('input[name="materiaal"]') as HTMLInputElement).value).toBe('');
    });

    it('the same selection keeps what was typed — only a CHANGE resets', async () => {
        const user = userEvent.setup();
        const { container, rerender } = render(<Harness vars={{ regel: A }} resetKey="vars.regel.id" />);
        const input = container.querySelector('input[name="dikte_mm"]');
        await user.clear(input!);
        await user.type(input!, '8');
        expect((input! as HTMLInputElement).value).toBe('8');
        // A re-render with the same row (a refresh that changed nothing) is
        // not a new selection.
        rerender(<Harness vars={{ regel: { ...A } }} resetKey="vars.regel.id" />);
        expect((container.querySelector('input[name="dikte_mm"]') as HTMLInputElement).value).toBe('8');
    });
});
