import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { GenerateDocumentFields } from './documentFields';
import type { FormRecord } from '../formState/types';

/** The settings form's side: `set` writes the draft, the draft comes back as props. */
function Harness({ onDays }: { onDays: (days: unknown) => void }) {
    const [draft, setDraft] = useState<FormRecord>({ content: '', format: 'pdf', expiresInDays: 7 });
    const set = (key: string, value: unknown) => {
        setDraft(d => ({ ...d, [key]: value }));
        if (key === 'expiresInDays') onDays(value);
    };
    // 'options' open: the section the "Keep for" field lives in.
    return <GenerateDocumentFields draft={draft} set={set} errorSections={new Set(['options'])} />;
}

describe('Make a document — "Keep for" days', () => {
    it('can be emptied and retyped', async () => {
        const user = userEvent.setup();
        const onDays = vi.fn();
        render(<Harness onDays={onDays} />);
        const field = screen.getByRole('spinbutton');
        expect(field).toHaveValue(7);

        await user.clear(field);
        // Emptied is emptied: no "1" pushed in under the cursor.
        expect(field).toHaveValue(null);
        expect(onDays).not.toHaveBeenCalled();

        await user.type(field, '3');
        expect(field).toHaveValue(3);
        expect(onDays).toHaveBeenLastCalledWith(3);
    });

    it('keeps the stored value inside 1–90 and shows it again on leaving the field', async () => {
        const user = userEvent.setup();
        const onDays = vi.fn();
        render(<Harness onDays={onDays} />);
        const field = screen.getByRole('spinbutton');

        await user.clear(field);
        await user.type(field, '400');
        expect(onDays).toHaveBeenLastCalledWith(90);
        await user.tab();
        expect(field).toHaveValue(90);

        await user.clear(field);
        await user.tab();
        expect(field).toHaveValue(90);
    });
});
