import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ParseJsonFields from './ParseJsonFields';
import type { FormRecord } from './formState/types';

const SAMPLE = { steps: { http: { output: { body: '{"customer":{"email":"a@b.c"},"total":12}' } } } };

/** SettingsForm's `set`: a function value is an updater on the current value. */
function Harness() {
    const [draft, setDraft] = useState<FormRecord>({
        sourceRef: 'steps.http.output.body', mode: 'paths', itemsRef: '',
        fields: [{ name: 'email', path: 'customer.email' }],
    });
    const set = (key: string, value: unknown) => setDraft(d => ({
        ...d, [key]: typeof value === 'function' ? (value as (cur: unknown, all: FormRecord) => unknown)(d[key], d) : value,
    }));
    return <ParseJsonFields step={{ id: 'pj1' }} draft={draft} set={set} previewSample={SAMPLE} />;
}

describe('ParseJsonFields — Map with AI', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('adds its rows to the fields as they are when the answer arrives', async () => {
        let answer: (r: Response) => void = () => {};
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
        const user = userEvent.setup();
        render(<Harness />);

        await user.type(screen.getByPlaceholderText(/describe the fields you want/i), 'the order total');
        await user.click(screen.getByRole('button', { name: /map with ai/i }));
        expect(screen.getByRole('button', { name: /mapping/i })).toBeDisabled();

        // The answer takes a while; the author goes on working in the list.
        const name = screen.getByLabelText('Field name');
        await user.clear(name);
        await user.type(name, 'contact_email');

        answer(new Response(JSON.stringify({ fields: [{ name: 'total', path: 'total', verified: true }] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
        await waitFor(() => expect(screen.getByRole('button', { name: /map with ai/i })).toBeEnabled());

        const values = (label: string) => screen.getAllByLabelText(label).map(el => (el as HTMLInputElement).value);
        expect(values('Field name')).toEqual(['contact_email', 'total']);
        expect(values('Field path')).toEqual(['customer.email', 'total']);
    });
});
