import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import type { AdoptionAreas } from './adoption.types';
import AreasSection, { foldAreas } from './AreasSection';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const areas = () => (ROUTES as unknown as Record<string, Handler>)['GET /api/usage/adoption/areas']({ state: createState(), query: new URLSearchParams('days=30') }) as AdoptionAreas;

describe('foldAreas', () => {
    it('keeps every series area with spend, sorted by cost, and folds the rest into a last "other"', () => {
        const rows = foldAreas(areas().areas);
        expect(rows.map(r => r.id)).toEqual(['agents', 'chat', 'automations', 'apps', 'cowork', 'meetings', 'other']);
        const other = rows[rows.length - 1];
        expect(other.cost).toBe(38);
        expect(other.folded).toEqual(['knowledge', 'documents', 'webpages', 'skills', 'datatables', 'media']);
        expect(rows.reduce((s, r) => s + r.cost, 0)).toBe(1284);
    });

    it('counts no calls when the server sent none (cloud customers)', () => {
        const noCalls = areas().areas.map(({ calls: _calls, ...a }) => a);
        expect(foldAreas(noCalls).every(r => r.calls === null)).toBe(true);
    });
});

describe('AreasSection', () => {
    it('lists the areas with spend and share, and opens one to its ledger sources', async () => {
        const user = userEvent.setup();
        render(<AreasSection data={areas()} currency="€" showCalls />);
        const list = screen.getByRole('list', { name: 'AI spend per area' });
        const rows = within(list).getAllByRole('button');
        expect(rows).toHaveLength(7);
        expect(rows[0].textContent).toContain('Agents');
        expect(rows[0].textContent).toContain('41%');
        expect(rows[6].textContent).toContain('Knowledge, Documents, Webpages');
        await user.click(rows[0]);
        expect(rows[0].getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('list', { name: 'Ledger sources' }).textContent).toContain('agent_stream');
    });

    it('draws the weekly chart with a legend per series and a link to its table view', () => {
        const { container } = render(<AreasSection data={areas()} currency="€" showCalls={false} />);
        expect(screen.getByRole('img', { name: 'AI spend per week, by area' })).toBeTruthy();
        const link = screen.getByRole('link', { name: 'Table view' });
        expect(link.getAttribute('href')).toBe('#adoption-areas-table');
        expect(container.querySelector('#adoption-areas-table')).not.toBeNull();
        expect(screen.queryByText(/calls/)).toBeNull();
    });

    it('says so when nothing was used', () => {
        render(<AreasSection data={{ areas: [], timeline: { weeks: [] }, partial: false }} currency="€" showCalls />);
        expect(screen.getAllByText('No AI usage recorded in this period.').length).toBe(2);
    });
});
