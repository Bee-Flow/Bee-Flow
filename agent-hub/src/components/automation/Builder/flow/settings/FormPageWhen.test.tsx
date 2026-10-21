import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FormPageFields } from './triggerEditors';
import type { TriggerDraft } from './triggerEditors.types';

const SAMPLE = { steps: { s1: { output: { amount: 5 } } } };
const FORM = { title: 'More', description: '', fields: [], theme: null };

/** The drawer's draft, kept the way the inspector keeps it, so every `set` is visible. */
function setup(initial: TriggerDraft) {
    const sets: Array<[string, unknown]> = [];
    function Host() {
        const [draft, setDraft] = useState(initial);
        return (
            <FormPageFields
                draft={draft}
                set={(key, value) => { sets.push([key, value]); setDraft(d => ({ ...d, [key]: value })); }}
                stepId="p1"
                previewSample={SAMPLE}
            />
        );
    }
    render(<Host />);
    return { sets, user: userEvent.setup() };
}

afterEach(() => cleanup());

describe('the page condition ("Only show this page when…")', () => {
    it('is offered on an input page, collapsed, and opens a condition builder', async () => {
        const { user } = setup({ mode: 'input', form: FORM });
        expect(screen.queryByText('Checked when the automation reaches this page. When it is not met, the page is skipped and its answers stay empty.')).toBeNull();
        await user.click(screen.getByRole('button', { name: /Only show this page when/ }));
        expect(screen.getByText('Checked when the automation reaches this page. When it is not met, the page is skipped and its answers stay empty.')).toBeTruthy();
    });

    it('is offered on a closing page too', () => {
        setup({ mode: 'ending', form: FORM });
        expect(screen.getByRole('button', { name: /Only show this page when/ })).toBeTruthy();
    });

    it('shows a stored condition open, and clearing it writes an empty string to draft.when', async () => {
        const { sets, user } = setup({ mode: 'input', form: FORM, when: 'steps.check.output.found == true' });
        expect(screen.queryByRole('button', { name: /Only show this page when/ })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Always show it' }));
        expect(sets.at(-1)).toEqual(['when', '']);
        expect(screen.getByRole('button', { name: /Only show this page when/ })).toBeTruthy();
    });

    it('writes the condition the builder produces to draft.when', async () => {
        const { sets, user } = setup({ mode: 'input', form: FORM, when: 'steps.s1.output.amount > 1000' });
        const number = document.querySelector('input[type="number"]') as HTMLInputElement;
        expect(number.value).toBe('1000');
        await user.clear(number);
        await user.type(number, '2000');
        expect(sets.at(-1)).toEqual(['when', 'steps.s1.output.amount > 2000']);
    });

    it('keeps the wait window on input pages only', () => {
        setup({ mode: 'input', form: FORM });
        expect(screen.getByText('Wait for an answer')).toBeTruthy();
        cleanup();
        setup({ mode: 'ending', form: FORM });
        expect(screen.queryByText('Wait for an answer')).toBeNull();
    });
});
