import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import FormBuilderFields from './FormBuilderFields';
import TypedNumberInput from './TypedNumberInput';

function Field({ initial, fallback, onStored }: { initial: number; fallback: number; onStored: (n: number) => void }) {
    const [value, setValue] = useState(initial);
    return <TypedNumberInput aria-label="Max" min={1} max={25} value={value} fallback={fallback} onNumber={(n) => { setValue(n); onStored(n); }} />;
}

describe('TypedNumberInput', () => {
    it('can be emptied and retyped: the empty box stores nothing and does not snap back', async () => {
        const user = userEvent.setup();
        const onStored = vi.fn();
        render(<Field initial={10} fallback={10} onStored={onStored} />);
        const box = screen.getByLabelText('Max');

        await user.clear(box);
        expect(box).toHaveValue(null);
        expect(onStored).not.toHaveBeenCalled();

        await user.type(box, '25');
        expect(box).toHaveValue(25);
        expect(onStored).toHaveBeenLastCalledWith(25);
    });

    it('shows the stored value again on leaving an empty box', async () => {
        const user = userEvent.setup();
        render(<Field initial={7} fallback={10} onStored={vi.fn()} />);
        const box = screen.getByLabelText('Max');
        await user.clear(box);
        await user.tab();
        expect(box).toHaveValue(7);
    });

    it('stores what the field stored before: a typed 0 is the default, and nothing is clamped', async () => {
        const user = userEvent.setup();
        const onStored = vi.fn();
        render(<Field initial={7} fallback={10} onStored={onStored} />);
        const box = screen.getByLabelText('Max');
        await user.clear(box);
        await user.type(box, '0');
        expect(onStored).toHaveBeenLastCalledWith(10);
        await user.clear(box);
        await user.type(box, '99');
        expect(onStored).toHaveBeenLastCalledWith(99);
    });
});

describe('FormBuilderFields — the number fields of a question', () => {
    function Controlled({ onForm }: { onForm: (form: { fields: { maxSizeMb?: number }[] }) => void }) {
        const [form, setForm] = useState({
            title: 'T', description: '', submitLabel: 'Submit', successMessage: 'Thanks!', theme: null,
            fields: [{ name: 'cv', type: 'file', label: 'CV', required: false, maxSizeMb: 10 }],
        });
        return <FormBuilderFields form={form} onChange={(next: typeof form) => { setForm(next); onForm(next); }} bindingBase="trigger.output" onStyleAssist={undefined} />;
    }

    it('"Max MB" can be cleared and retyped', async () => {
        const user = userEvent.setup();
        const onForm = vi.fn();
        render(<Controlled onForm={onForm} />);
        await user.click(screen.getByLabelText('Expand question 1'));
        const box = screen.getByLabelText('Max MB');
        await user.clear(box);
        expect(box).toHaveValue(null);
        await user.type(box, '3');
        expect(box).toHaveValue(3);
        expect(onForm.mock.lastCall?.[0].fields[0].maxSizeMb).toBe(3);
    });
});
