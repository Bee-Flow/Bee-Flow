// Cowork's home on the page: the desktop pane scrolls from the top (nothing above the middle is cut off), a phone shows
// the home too, and a brief handed over by "You ask this every Monday" opens set to run every Monday. The network is the
// seam (a recording fetch); no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient, renderHookWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import CoworkPage from './CoworkPage';
import { handBrief } from './coworkHandedBrief';
import useCoworkComposer from './useCoworkComposer';

const HOME = {
    how: {},
    today: [{ kind: 'next', itemId: 'w1', title: 'Supplier radar', at: '2026-11-24T06:30:00.000Z', status: null, runId: null }],
    cost: { byCurrency: {}, calls: 0 },
};
const ITEM = { id: 'w1', title: 'Supplier radar', prompt: 'Which orders are open?', isActive: true, lastStatus: null, repeatInterval: 'weekly', runCount: 0 };

const serve = () => stubRecordingFetch(({ url }) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path === '/api/cowork') return jsonResponse({ schedules: [ITEM], maxSchedules: 10 });
    if (path === '/api/cowork/home') return jsonResponse(HOME);
    if (path.endsWith('/needs-you')) return jsonResponse({ needs: [], count: 0 });
    if (path.endsWith('/daily-mail')) return jsonResponse({ enabled: false, timeZone: 'UTC', available: false });
    return jsonResponse({});
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkPage — the home', () => {
    it('scrolls the pane from the top: the box that centres is at least the pane, never the scroller itself', async () => {
        serve();
        renderWithClient(<CoworkPage />);
        const pane = await screen.findByTestId('cowork-home-pane');
        expect(pane).toHaveClass('overflow-y-auto');
        expect(pane).not.toHaveClass('justify-center');
        expect(screen.getByTestId('cowork-home-pane-body')).toHaveClass('min-h-full', 'justify-center');
    });

    it('shows the home on a phone too, under the box and above the list', async () => {
        serve();
        renderWithClient(<CoworkPage isMobile />);
        const home = await screen.findByTestId('cowork-home-phone');
        await waitFor(() => expect(home.querySelector('[data-testid="cowork-today"]')).not.toBeNull());
        const row = await screen.findByTestId('cowork-row');
        // The home comes before the list in the one scroll.
        expect(home.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('opens with a handed-over brief in the box, set to run every week from the next Monday', async () => {
        serve();
        handBrief('Which supplier orders are open?', 1);
        renderWithClient(<CoworkPage />);
        expect(await screen.findByTestId('cowork-brief-input')).toHaveValue('Which supplier orders are open?');
        const composer = screen.getByTestId('cowork-composer');
        expect(within(composer).getByText('Every week')).toBeInTheDocument();
        // Not "Now / Once": the button schedules rather than runs.
        expect(screen.getByTestId('cowork-send')).toHaveTextContent('Schedule');
    });
});

describe('useCoworkComposer — every week on a given day', () => {
    it('starts on the next such day at 09:00, every week, as the person\'s own choice', () => {
        serve();
        const { result } = renderHookWithClient(() => useCoworkComposer({ weeklyOn: 1 }));
        const { when, repeatInterval, touched } = result.current;
        expect(when.presetId).toBe('custom');
        expect(new Date(`${when.date}T${when.time}`).getDay()).toBe(1);
        expect(when.time).toBe('09:00');
        expect(repeatInterval).toBe('weekly');
        expect(touched).toMatchObject({ when: true, repeat: true });
    });

    it('starts at "now, once" without a weekday', () => {
        serve();
        const { result } = renderHookWithClient(() => useCoworkComposer({}));
        expect(result.current.when.presetId).toBe('now');
        expect(result.current.repeatInterval).toBe('');
    });
});
