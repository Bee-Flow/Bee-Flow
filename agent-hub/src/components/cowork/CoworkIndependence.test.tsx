// "How independent may it be?" in the plan card: what each level asks for this plan, a level that is not open says
// why, and choosing one saves it. The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkIndependence from './CoworkIndependence';
import type { IndependenceState } from '@/api/coworkIndependence';

const t = (_k: string, en: string, vars?: Record<string, unknown>) => en.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? ''));

const state = (over: Partial<IndependenceState> = {}): IndependenceState => ({
    chosen: null, level: 'asks_before_sending', asksAvailable: true, letThrough: 3, needed: 10,
    options: [
        { level: 'asks_everything', open: true, asksBefore: ['Update the table', 'Mail the supplier'] },
        { level: 'asks_before_sending', open: true, asksBefore: ['Mail the supplier'] },
        { level: 'on_its_own', open: false, asksBefore: [] },
    ],
    ...over,
});

let calls: RecordedCall[];
const serve = (initial: IndependenceState) => {
    calls = stubRecordingFetch(({ method, body }) => jsonResponse(method === 'PUT' ? { ...initial, chosen: (body as { level: string }).level } : initial));
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkIndependence', () => {
    it('says what each level asks for this plan, and when "on its own" opens', async () => {
        serve(state());
        renderWithClient(<CoworkIndependence coworkId="w1" t={t} />);
        expect(await screen.findByText('Waits for your decision before: Mail the supplier')).toBeInTheDocument();
        expect(screen.getByText('Waits for your decision before: Update the table, Mail the supplier')).toBeInTheDocument();
        expect(screen.getByText('Opens after 10 runs you let through without stopping one (3 so far).')).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: /Ask before anything leaves Bee Flow/ })).toBeChecked();
        expect(screen.getByRole('radio', { name: /On its own/ })).toBeDisabled();
    });

    it('a plan that only saves drafts is not called one that "changes and sends nothing"', async () => {
        // It may change Outlook (saves drafts) and sends nothing: "ask before sending" has nothing to ask, but the plan
        // still changes things, without asking. Only "ask about everything" with nothing to ask means it changes nothing.
        serve(state({ options: [
            { level: 'asks_everything', open: true, asksBefore: ['Save the reply as a draft'] },
            { level: 'asks_before_sending', open: true, asksBefore: [] },
            { level: 'on_its_own', open: false, asksBefore: [] },
        ] }));
        renderWithClient(<CoworkIndependence coworkId="w1" t={t} />);
        expect(await screen.findByText('Nothing in this plan sends anything, so nothing waits. What it changes, it changes without asking.')).toBeInTheDocument();
        expect(screen.queryByText(/changes and sends nothing/)).toBeNull();
    });

    it('choosing a level saves it at once', async () => {
        serve(state());
        renderWithClient(<CoworkIndependence coworkId="w1" t={t} />);
        await userEvent.setup().click(await screen.findByRole('radio', { name: /Ask me about everything/ }));
        await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1));
        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.url).toMatch(/\/api\/cowork\/w1\/plan\/independence$/);
        expect(put?.body).toEqual({ level: 'asks_everything' });
        await waitFor(() => expect(screen.getByRole('radio', { name: /Ask me about everything/ })).toBeChecked());
    });

    it('a choice to be asked that can no longer be honoured says so', async () => {
        serve(state({ chosen: 'asks_everything', level: null, asksAvailable: false }));
        renderWithClient(<CoworkIndependence coworkId="w1" t={t} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(/asking needs approvals/);
    });
});
