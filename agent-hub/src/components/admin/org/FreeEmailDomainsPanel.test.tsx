// Organisation → free email-provider domains. Pinned: a note stays for its own
// three seconds; the timer of the note before it must not take it down early.
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import FreeEmailDomainsPanel from './FreeEmailDomainsPanel';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setDemoTransport(async () => json({ builtin: ['gmail.com'], extra: [] }));
});
afterEach(() => {
    vi.useRealTimers();
    setDemoTransport(null);
});

describe('FreeEmailDomainsPanel notes', () => {
    it('keeps a second note for its full time', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderWithClient(<FreeEmailDomainsPanel />);
        const input = await screen.findByPlaceholderText('e.g. proton.me or someone@proton.me');

        await user.type(input, 'gmail.com');
        await user.click(screen.getByRole('button', { name: 'Add' }));
        expect(screen.getByText('"gmail.com" is already a built-in domain')).toBeTruthy();

        await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
        await user.clear(input);
        await user.type(input, 'nonsense');
        await user.click(screen.getByRole('button', { name: 'Add' }));
        expect(screen.getByText('Not a valid domain: "nonsense"')).toBeTruthy();

        // The first note's three seconds are over; the second one is one second old.
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.getByText('Not a valid domain: "nonsense"')).toBeTruthy();
        await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
        expect(screen.queryByText('Not a valid domain: "nonsense"')).toBeNull();
    });
});
