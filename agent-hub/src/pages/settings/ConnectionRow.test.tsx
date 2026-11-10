import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ConnectionRow } from './ConnectionRow';
import type { Connection } from './ConnectionsManager.types';

const CONNECTION: Connection = { id: 'c1', provider: 'fireflies', label: 'Work key', kind: 'api_key', isDefault: false, secretMeta: {} };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchSpy: MockInstance<typeof fetch>;
/** The requests of one HTTP method the row made. */
const calls = (method: string) => fetchSpy.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === method);

beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
afterEach(() => { fetchSpy.mockRestore(); });

describe('ConnectionRow — renaming', () => {
    it('keeps the box open on what was typed when the rename is refused, and closes it once it is taken', async () => {
        const user = userEvent.setup();
        const onChanged = vi.fn(async () => {});
        fetchSpy.mockImplementationOnce(async () => json({ error: 'That name is taken' }, 409));
        render(<ConnectionRow connection={CONNECTION} grants={[]} onChanged={onChanged} />);

        await user.click(screen.getByText('Rename'));
        const box = screen.getByLabelText('Connection name');
        await user.clear(box);
        await user.type(box, 'Team key{Enter}');

        expect(await screen.findByRole('alert')).toHaveTextContent('That name is taken');
        // It used to close here: the row showed "Work key" again while the box
        // kept "Team key" for the next time it was opened.
        expect(screen.getByLabelText('Connection name')).toHaveValue('Team key');
        expect(onChanged).not.toHaveBeenCalled();

        fetchSpy.mockImplementationOnce(async () => json({ ok: true }));
        await user.click(screen.getByTitle('Save'));
        await waitFor(() => expect(screen.queryByLabelText('Connection name')).toBeNull());
        expect(onChanged).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('sends one request when Enter is pressed again while the rename is on its way', async () => {
        const user = userEvent.setup();
        let land: (res: Response) => void = () => {};
        fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => { land = resolve; }));
        render(<ConnectionRow connection={CONNECTION} grants={[]} onChanged={async () => {}} />);

        await user.click(screen.getByText('Rename'));
        const box = screen.getByLabelText('Connection name');
        await user.clear(box);
        await user.type(box, 'Team key{Enter}{Enter}');
        expect(calls('PATCH')).toHaveLength(1);
        land(json({ ok: true }));
        await waitFor(() => expect(screen.queryByLabelText('Connection name')).toBeNull());
    });
});

describe('ConnectionRow — lending to a teammate', () => {
    it('sends one share when Enter is pressed again while the first is on its way', async () => {
        const user = userEvent.setup();
        let land: (res: Response) => void = () => {};
        fetchSpy.mockImplementation(() => new Promise<Response>((resolve) => { land = resolve; }));
        render(<ConnectionRow connection={CONNECTION} grants={[]} onChanged={async () => {}} />);

        await user.click(screen.getByTitle('Share'));
        await user.type(screen.getByLabelText('Teammate email'), 'ann@example.com{Enter}{Enter}');
        expect(calls('POST')).toHaveLength(1);
        land(json({ ok: true }, 201));
        await waitFor(() => expect(screen.getByLabelText('Teammate email')).toHaveValue(''));
    });
});
