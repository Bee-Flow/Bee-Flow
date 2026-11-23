// Trust per step and recipient: a step that earned it is offered, a trusted one can be asked about again, and nothing
// shows before any decision. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkTrust from './CoworkTrust';

const t = (_k: string, en: string, vars?: Record<string, unknown>) => en.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? ''));
let calls: RecordedCall[];
const serve = (entries: unknown[]) => {
    calls = stubRecordingFetch(({ method, body }) => jsonResponse({
        needed: 5, ceilingAllows: true,
        entries: method === 'PUT' ? [{ ...(entries[0] as object), trusted: (body as { trusted: boolean }).trusted }] : entries,
    }));
};
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkTrust', () => {
    it('offers a step that earned it, and lets it go on its own', async () => {
        serve([{ stepId: 'send', title: 'Mail the supplier', recipient: 'o@s.example', letThrough: 6, trusted: false, canTrust: true }]);
        renderWithClient(<CoworkTrust coworkId="w1" t={t} />);
        expect(await screen.findByText('You let "Mail the supplier" to o@s.example through 6 times. Let it go on its own?')).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Let it go on its own' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
        expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ stepId: 'send', recipient: 'o@s.example', trusted: true });
        expect(await screen.findByRole('button', { name: 'Ask me again' })).toBeInTheDocument();
    });

    it('a step still counting has no button; no decisions, nothing at all', async () => {
        serve([{ stepId: 'send', title: 'Mail the supplier', recipient: '*', letThrough: 2, trusted: false, canTrust: false }]);
        const { unmount } = renderWithClient(<CoworkTrust coworkId="w1" t={t} />);
        expect(await screen.findByText('"Mail the supplier" to the addresses it picks: let through 2 of 5 times.')).toBeInTheDocument();
        expect(screen.queryByRole('button')).toBeNull();
        unmount();
        serve([]);
        renderWithClient(<CoworkTrust coworkId="w1" t={t} />);
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(screen.queryByTestId('cowork-trust')).toBeNull();
    });
});
