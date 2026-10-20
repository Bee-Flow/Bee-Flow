import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';
import PublicFormRenderer from '../../forms/PublicFormRenderer';
import type { FormDef } from '../../forms/PublicFormRenderer.types';
import FormScenarioPicker from './FormScenarioPicker';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

const LIST = [
    { scenarioId: 'fsc_1', name: 'Complete request', hasTriggerAnswers: true, pages: [{ stepId: 'page2', fieldCount: 1 }], skipped: [{ stepId: null, field: 'cv', reason: 'file' }] },
    { scenarioId: 'fsc_2', name: 'Second page only', hasTriggerAnswers: false, pages: [{ stepId: 'page2', fieldCount: 1 }], skipped: [] },
];
const DETAIL = {
    ...LIST[0],
    answers: { trigger: { city: 'Utrecht' }, pages: { page2: { street: 'Main street 1' } } },
};
const DETAIL_2 = { ...LIST[1], answers: { trigger: null, pages: { page2: { street: 'Side street 2' } } } };

let detailCalls: string[] = [];

beforeEach(() => {
    detailCalls = [];
    vi.mocked(authFetch).mockImplementation(((url: string) => {
        if (url.endsWith('/a1/form-scenarios')) return reply(200, { scenarios: LIST, limits: { max: 50 } });
        const m = /\/a1\/form-scenarios\/(fsc_\d)$/.exec(url);
        if (m) {
            detailCalls.push(m[1]);
            return reply(200, { scenario: m[1] === 'fsc_1' ? DETAIL : DETAIL_2 });
        }
        return reply(404, {});
    }) as typeof authFetch);
});
afterEach(() => cleanup());

const form = (name: string, label: string) => ({
    title: 'Page', description: '', submitLabel: 'Go', successMessage: 'Done', theme: {},
    fields: [{ name, type: 'text', label, required: false, placeholder: '', help: '' }],
}) as unknown as FormDef;

/** The picker over a form, wired the way the test overlay wires them. */
function Page({ stepId, definition }: { stepId: string | null; definition: FormDef }) {
    const [prefill, setPrefill] = useState<Record<string, unknown> | null>(null);
    return (
        <>
            <FormScenarioPicker automationId="a1" stepId={stepId} onPick={setPrefill} />
            <PublicFormRenderer form={definition} prefill={prefill} showSuccess={false} />
        </>
    );
}

describe('FormScenarioPicker', () => {
    it('fills the first page from the trigger answers', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<Page stepId={null} definition={form('city', 'City')} />));
        const select = await screen.findByRole('combobox', { name: 'Fill from a saved scenario' });
        // Only a scenario that answered the start form is offered on page one.
        expect(Array.from((select as HTMLSelectElement).options).map(o => o.textContent)).toEqual(['Start with an empty form', 'Complete request']);
        expect(detailCalls).toEqual([]);
        await user.selectOptions(select, 'fsc_1');
        await waitFor(() => expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Utrecht'));
        expect(screen.getByText('Left empty: cv. Files and app picks are not saved.')).toBeTruthy();
    });

    it('fills a later page from the answers of its own step', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<Page stepId="page2" definition={form('street', 'Street')} />));
        const select = await screen.findByRole('combobox', { name: 'Fill from a saved scenario' });
        expect((select as HTMLSelectElement).options).toHaveLength(3);
        await user.selectOptions(select, 'fsc_2');
        await waitFor(() => expect((screen.getByLabelText('Street') as HTMLInputElement).value).toBe('Side street 2'));
        await user.selectOptions(select, 'fsc_1');
        await waitFor(() => expect((screen.getByLabelText('Street') as HTMLInputElement).value).toBe('Main street 1'));
        // The first page's skipped file is not mentioned on this page.
        expect(screen.queryByText(/Left empty/)).toBeNull();
    });

    it('empties the form again when the person goes back to no scenario', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<Page stepId={null} definition={form('city', 'City')} />));
        const select = await screen.findByRole('combobox', { name: 'Fill from a saved scenario' });
        await user.selectOptions(select, 'fsc_1');
        await waitFor(() => expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Utrecht'));
        await user.selectOptions(select, '');
        await waitFor(() => expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe(''));
    });

    it('stays out of the way when no scenario fits the page', async () => {
        const { container } = render(withQueryClient(<Page stepId="page9" definition={form('city', 'City')} />));
        await waitFor(() => expect(vi.mocked(authFetch)).toHaveBeenCalled());
        await waitFor(() => expect(container.querySelector('select')).toBeNull());
    });
});
