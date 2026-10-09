import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRequestFields as FieldsJs } from './httpRequestFields';

const HttpRequestFields = FieldsJs as unknown as ComponentType<Record<string, unknown>>;
const OWNER = 'builder%5B0%5D%5BorderByDesc%5D=created_at&builder%5B1%5D%5Bwith%5D%5B0%5D=categories&builder%5B2%5D%5Bpaginate%5D=5';

afterEach(() => cleanup());

function renderFields(draft: Record<string, unknown>, set = vi.fn()) {
    render(<HttpRequestFields draft={draft} set={set} groups={[]} errorSections={new Set(['query'])} />);
    return set;
}

describe('HTTP request query parameters', () => {
    it('switches the section on and off', async () => {
        const set = renderFields({ url: 'https://x.example/api', method: 'GET' });
        await userEvent.click(screen.getByLabelText('Send query parameters'));
        expect(set).toHaveBeenCalledWith('query', { mode: 'fields', items: [] });
    });

    it('turning it off clears the setting', async () => {
        const set = renderFields({ url: 'https://x.example/api', query: { mode: 'fields', items: [] } });
        await userEvent.click(screen.getByLabelText('Send query parameters'));
        expect(set).toHaveBeenCalledWith('query', null);
    });

    it('fields mode: adds a row and edits its name', async () => {
        const set = renderFields({ url: 'https://x.example/api', query: { mode: 'fields', items: [{ key: 'page', value: '1' }] } });
        expect(screen.getAllByTestId('http-query-row')).toHaveLength(1);
        await userEvent.click(screen.getByText('Add parameter'));
        expect(set).toHaveBeenCalledWith('query', { mode: 'fields', items: [{ key: 'page', value: '1' }, { key: '', value: '' }] });
        await userEvent.type(screen.getByLabelText('Parameter name'), 'x');
        expect(set).toHaveBeenLastCalledWith('query', { mode: 'fields', items: [{ key: 'pagex', value: '1' }] });
    });

    it('json mode: shows the JSON field, an error for broken JSON, and the preview', () => {
        renderFields({ url: 'https://x.example/api/tickets', query: { mode: 'json', json: '{oops' } });
        expect(screen.getByTestId('http-query-json')).toBeTruthy();
        expect(screen.getByTestId('http-query-json-error').textContent).toMatch(/not valid JSON/);
    });

    it('shows the final URL for the owner example', () => {
        renderFields({
            url: 'https://x.example/api/tickets',
            query: { mode: 'json', json: '{"builder":[{"orderByDesc":"created_at"},{"with":["categories"]},{"paginate":5}]}' },
        });
        expect(screen.getByTestId('http-query-preview-url').textContent).toBe(`https://x.example/api/tickets?${OWNER}`);
    });

    it('switching the mode keeps the array format', async () => {
        const set = renderFields({ url: 'https://x.example/api', query: { mode: 'fields', items: [], arrayFormat: 'repeat' } });
        await userEvent.selectOptions(screen.getByTestId('http-query-mode'), 'json');
        expect(set).toHaveBeenCalledWith('query', { mode: 'json', json: '', arrayFormat: 'repeat' });
    });

    it('array format lives under Advanced and is changeable', async () => {
        const set = renderFields({ url: 'https://x.example/api', query: { mode: 'fields', items: [] } });
        await userEvent.selectOptions(screen.getByTestId('http-query-array-format'), 'brackets');
        expect(set).toHaveBeenCalledWith('query', { mode: 'fields', items: [], arrayFormat: 'brackets' });
    });

    it('moves the query out of the URL into nested JSON', async () => {
        const set = renderFields({ url: `https://x.example/api/tickets?${OWNER}&page=1`, method: 'GET' });
        await userEvent.click(screen.getByTestId('http-query-move'));
        const queryCall = set.mock.calls.find((c) => c[0] === 'query');
        expect(JSON.parse(queryCall![1].json)).toEqual({
            builder: [{ orderByDesc: 'created_at' }, { with: ['categories'] }, { paginate: '5' }], page: '1',
        });
        expect(set).toHaveBeenCalledWith('url', 'https://x.example/api/tickets');
    });

    it('offers no move action when the URL has no query', () => {
        renderFields({ url: 'https://x.example/api', method: 'GET' });
        expect(screen.queryByTestId('http-query-move')).toBeNull();
    });
});
