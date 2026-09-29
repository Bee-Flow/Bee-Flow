import { render, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

import SolutionAddResource, { rowsOf } from './SolutionAddResource';

/**
 * Filing something you already made into a Solution.
 *
 * The route it drives has existed since the membership registry landed and had
 * no caller at all. Two things are pinned: an unreadable listing is never shown
 * as "you have none", and the server's own refusal is what the user reads —
 * this screen does not re-implement the ownership rule and cannot drift from
 * it.
 */

function mockFetch({ list = { apps: [{ id: 'app1', name: 'Desk' }, { id: 'app2', name: 'Rota' }] }, listOk = true, attachOk = true } = {}) {
    globalThis.__authFetch = vi.fn(async (url, init) => {
        if (init?.method === 'PUT') {
            return attachOk
                ? { ok: true, status: 200, json: async () => ({ success: true }) }
                : { ok: false, status: 404, json: async () => ({ error: 'Not found, or not yours to move' }) };
        }
        return listOk
            ? { ok: true, status: 200, json: async () => list }
            : { ok: false, status: 500, json: async () => ({ error: 'Request failed' }) };
    });
}

beforeEach(() => mockFetch());
afterEach(() => { delete globalThis.__authFetch; });

const renderPicker = (props = {}) => render(
    <SolutionAddResource projectId="p1" alreadyIn={new Set()} {...props} />,
);

describe('the listing', () => {
    it('reads the array whatever the endpoint calls it', () => {
        expect(rowsOf({ apps: [1] })).toEqual([1]);
        expect(rowsOf({ tasks: [1, 2] })).toEqual([1, 2]);
        expect(rowsOf([3])).toEqual([3]);
        expect(rowsOf({ error: 'nope' })).toBeNull();
        expect(rowsOf(null)).toBeNull();
    });

    it('offers what you own and have not filed here yet', async () => {
        const { getByLabelText, findByText, queryByText } = renderPicker({ alreadyIn: new Set(['app:app2']) });
        fireEvent.change(getByLabelText(/Add existing|add_existing/i), { target: { value: 'app' } });
        expect(await findByText('Desk')).toBeTruthy();
        await waitFor(() => expect(queryByText('Rota')).toBeNull());
    });

    it('a listing that could not be read says so — NOT "nothing left to add"', async () => {
        mockFetch({ listOk: false });
        const { getByLabelText, findByTestId, queryByText } = renderPicker();
        fireEvent.change(getByLabelText(/Add existing|add_existing/i), { target: { value: 'app' } });
        expect(await findByTestId('solution-add-error')).toBeTruthy();
        expect(queryByText('Nothing of yours left to add here.')).toBeNull();
    });

    it('an empty listing you own really does say nothing left', async () => {
        mockFetch({ list: { apps: [] } });
        const { getByLabelText, findByText } = renderPicker();
        fireEvent.change(getByLabelText(/Add existing|add_existing/i), { target: { value: 'app' } });
        expect(await findByText('Nothing of yours left to add here.')).toBeTruthy();
    });
});

describe('filing one in', () => {
    it('PUTs the kind and id the server expects', async () => {
        const onAdded = vi.fn();
        const { getByLabelText, findByText } = renderPicker({ onAdded });
        fireEvent.change(getByLabelText(/Add existing|add_existing/i), { target: { value: 'app' } });
        fireEvent.click(await findByText('Desk'));
        await waitFor(() => expect(onAdded).toHaveBeenCalled());
        const put = globalThis.__authFetch.mock.calls.find(([, i]) => i?.method === 'PUT');
        expect(JSON.parse(put[1].body)).toEqual({ kind: 'app', id: 'app1', attach: true });
    });

    it('a refusal shows the SERVER\'s words rather than a guess made here', async () => {
        mockFetch({ attachOk: false });
        const { getByLabelText, findByText, findByTestId } = renderPicker();
        fireEvent.change(getByLabelText(/Add existing|add_existing/i), { target: { value: 'app' } });
        fireEvent.click(await findByText('Desk'));
        expect((await findByTestId('solution-add-error')).textContent).toContain('not yours to move');
    });
});
