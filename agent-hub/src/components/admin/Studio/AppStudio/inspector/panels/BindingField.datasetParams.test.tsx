import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import BindingField from './BindingField';
import { EditorChromeContext } from '../../editor/EditorChromeContext';

/**
 * A saved view that declares parameters gets one value field per parameter on
 * its binding; a view without parameters shows none, and clearing the last
 * value drops `params` from the binding again.
 */

const DATASETS = [
    { id: 'ds_region', name: 'By region', descriptor: { params: [{ name: 'region' }, { name: 'min', type: 'number' }], aggregates: [{ fn: 'count', as: 'n' }] } },
    { id: 'ds_plain', name: 'All', descriptor: { aggregates: [{ fn: 'count', as: 'n' }] } },
];

beforeEach(() => {
    setDemoTransport(async (url) => {
        const body = url.endsWith('/datasets') ? { datasets: DATASETS } : { tables: [] };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
});
afterEach(() => { setDemoTransport(null); });

function renderField(value: unknown) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn();
    render(
        <QueryClientProvider client={client}>
            <EditorChromeContext.Provider value={{ appId: 'app-1' }}>
                <BindingField label="Source" value={value} onChange={onChange} definition={{ screens: [] }} />
            </EditorChromeContext.Provider>
        </QueryClientProvider>,
    );
    return { onChange, last: () => onChange.mock.calls.at(-1)?.[0] };
}

describe('BindingField — parameters of a saved view', () => {
    it('offers one field per declared parameter and writes its value', async () => {
        const user = userEvent.setup();
        const { last } = renderField({ kind: 'dataset', datasetId: 'ds_region' });
        expect(await screen.findByText('Parameters of this view')).toBeTruthy();
        await user.type(screen.getByLabelText('Param region'), 'E');
        expect(last()).toEqual({ kind: 'dataset', datasetId: 'ds_region', params: { region: 'E' } });
        expect(screen.getByLabelText('Param min')).toBeTruthy();
    });

    it('drops params when the last value is cleared', async () => {
        const user = userEvent.setup();
        const { last } = renderField({ kind: 'dataset', datasetId: 'ds_region', params: { region: 'E' } });
        await user.clear(await screen.findByLabelText('Param region'));
        expect(last()).toEqual({ kind: 'dataset', datasetId: 'ds_region' });
    });

    it('shows nothing extra for a view without parameters', async () => {
        renderField({ kind: 'dataset', datasetId: 'ds_plain' });
        await screen.findByRole('option', { name: 'All' });
        expect(screen.queryByText('Parameters of this view')).toBeNull();
    });
});
