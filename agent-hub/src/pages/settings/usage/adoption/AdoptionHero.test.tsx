import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import type { AdoptionSummary } from './adoption.types';
import AdoptionHero from './AdoptionHero';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const summary = (q: string) => (ROUTES as unknown as Record<string, Handler>)['GET /api/usage/adoption/summary']({ state: createState(), query: new URLSearchParams(q) }) as AdoptionSummary;

describe('AdoptionHero', () => {
    it('leads with the AI-active share, its change, and the four tiles', () => {
        render(<AdoptionHero summary={summary('days=30')} currency="€" showCalls />);
        expect(screen.getByText('72%')).toBeTruthy();
        expect(screen.getByText('AI-active members · last 30 days')).toBeTruthy();
        expect(screen.getByText('107 of 148 members used AI')).toBeTruthy();
        expect(screen.getByText('↑ 5 pts')).toBeTruthy();
        expect(screen.getByText('Members')).toBeTruthy();
        expect(screen.getByText('€1284.00')).toBeTruthy();
        expect(screen.getByText(/25,640 calls|25.640 calls|25 640 calls/)).toBeTruthy();
        expect(screen.getByRole('list', { name: 'Members by activity' }).textContent).toContain('Signed in only');
        expect(screen.getByRole('img', { name: /AI-active 107/ })).toBeTruthy();
    });

    it('hides the change when compare is off', () => {
        render(<AdoptionHero summary={summary('days=30')} currency="€" showCalls compare={false} />);
        expect(screen.queryByTestId('delta-pill')).toBeNull();
        expect(screen.getByText('72%')).toBeTruthy();
    });

    it('leaves a null segment out of the legend and links to the Areas view', async () => {
        const user = userEvent.setup();
        const onOpenAreas = vi.fn();
        render(<AdoptionHero summary={summary('startDate=2026-10-01&endDate=2026-10-31')} currency="€" showCalls onOpenAreas={onOpenAreas} />);
        expect(screen.getByRole('list', { name: 'Members by activity' }).textContent).not.toContain('Dormant');
        await user.click(screen.getByRole('button', { name: /Where the AI goes/ }));
        expect(onOpenAreas).toHaveBeenCalledTimes(1);
    });

    it('leaves the call count out when calls are not shown (cloud customers)', () => {
        render(<AdoptionHero summary={summary('days=30')} currency="€" showCalls={false} />);
        expect(screen.queryByText(/calls/)).toBeNull();
    });

    it('says the sign-in figures need a relative period for an absolute window', () => {
        render(<AdoptionHero summary={summary('startDate=2026-10-01&endDate=2026-10-31')} currency="£" showCalls />);
        expect(screen.getByText('Needs a relative period (7, 30 or 90 days)')).toBeTruthy();
        expect(screen.getByRole('list', { name: 'Members by activity' }).textContent).not.toContain('Signed in only');
        expect(screen.getByText('£1284.00')).toBeTruthy();
    });
});
