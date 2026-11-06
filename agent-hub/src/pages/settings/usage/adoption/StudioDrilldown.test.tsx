import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import type { AdoptionStudio } from './adoption.types';
import StudioDrilldown from './StudioDrilldown';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const kinds = () => ((ROUTES as unknown as Record<string, Handler>)['GET /api/usage/adoption/studio']({ state: createState(), query: new URLSearchParams() }) as AdoptionStudio).kinds;

function install(overrides: DemoRoutes = {}) {
    setDemoTransport(createDemoTransport({ ...(ROUTES as unknown as DemoRoutes), ...overrides }, createState()));
}

afterEach(() => { setDemoTransport(null); vi.restoreAllMocks(); });

describe('StudioDrilldown', () => {
    it('shows the kind\'s numbers, its items with their makers, and pseudonymous top users', async () => {
        install();
        const agent = kinds().find(k => k.kind === 'agent')!;
        renderWithClient(<StudioDrilldown kind={agent} qs="days=30" currency="€" scopeLabel="6 Oct – 5 Nov 2026 · all groups" />);
        const dialog = await screen.findByRole('region');
        expect(within(dialog).getByText('Agents · 42 in the organisation')).toBeTruthy();
        expect(within(dialog).getByText('6 Oct – 5 Nov 2026 · all groups')).toBeTruthy();
        expect(await within(dialog).findByText('All items · 42')).toBeTruthy();
        expect(within(dialog).getAllByText(/^by Alex Morgan/).length).toBeGreaterThan(0);
        const top = within(dialog).getByRole('list', { name: 'Who uses it most' });
        expect(within(top).getAllByText(/^Member · /).length).toBe(5);
        expect(within(dialog).getAllByText('Whole organisation').length).toBeGreaterThan(1);
    });

    it('says "no signal" for a kind nothing records the use of', async () => {
        install();
        const kb = kinds().find(k => k.kind === 'kb')!;
        renderWithClient(<StudioDrilldown kind={kb} qs="days=30" currency="€" scopeLabel="" />);
        const dialog = await screen.findByRole('region');
        expect(within(dialog).getAllByText('no signal').length).toBe(2);
    });

    it('offers no "Unused" filter for a kind nothing records the use of', async () => {
        install();
        const kb = kinds().find(k => k.kind === 'kb')!;
        expect(kb.usage).toBeNull();
        renderWithClient(<StudioDrilldown kind={kb} qs="days=30" currency="€" scopeLabel="" />);
        const dialog = await screen.findByRole('region');
        await within(dialog).findByText(/^All items · /);
        expect(within(dialog).queryByRole('button', { name: /^Unused/ })).toBeNull();
    });

    it('lists as unused exactly the server\'s unused items, not every item without a use', async () => {
        const user = userEvent.setup();
        const items = [
            { id: 'a1', name: 'Published, unused', ownerId: 'u1', ownerName: 'Alex Morgan', audience: 'org', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, people: 0, uses: 0, cost: 0 },
            { id: 'a2', name: 'Private draft', ownerId: 'u1', ownerName: 'Alex Morgan', audience: 'private', createdAt: '2026-09-02T00:00:00Z', lastUsedAt: null, people: 0, uses: 0, cost: 0 },
            { id: 'a3', name: 'Busy one', ownerId: 'u1', ownerName: 'Alex Morgan', audience: 'org', createdAt: '2026-09-03T00:00:00Z', lastUsedAt: '2026-11-01T00:00:00Z', people: 3, uses: 9, cost: 1 },
        ];
        install({
            'GET /api/usage/adoption/studio/items': () => ({
                kind: 'agent', items, topPeople: [], total: 3,
                unused: [{ id: 'a1', name: 'Published, unused', ownerName: 'Alex Morgan', publishedAt: '2026-09-01T00:00:00Z', lastUsedAt: null }],
            }),
        });
        const agent = kinds().find(k => k.kind === 'agent')!;
        renderWithClient(<StudioDrilldown kind={agent} qs="days=30" currency="€" scopeLabel="" />);
        const dialog = await screen.findByRole('region');
        await within(dialog).findByText('All items · 3');
        const chip = within(dialog).getByRole('button', { name: /^Unused/ });
        expect(chip.textContent).toContain('1');
        await user.click(chip);
        const table = within(dialog).getByRole('table');
        expect(within(table).getByText('Published, unused')).toBeTruthy();
        expect(within(table).queryByText('Private draft')).toBeNull();
        expect(within(table).queryByText('Busy one')).toBeNull();
    });

    it('filters to the unused items and exports its items', async () => {
        install();
        const user = userEvent.setup();
        const blobs: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const agent = kinds().find(k => k.kind === 'agent')!;
        renderWithClient(<StudioDrilldown kind={agent} qs="days=30" currency="€" scopeLabel="" />);
        const dialog = await screen.findByRole('region');
        await within(dialog).findByText('All items · 42');
        await user.click(within(dialog).getByRole('button', { name: /^Unused/ }));
        const rows = within(dialog).getAllByRole('row').slice(1);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(25);
        await user.click(within(dialog).getByRole('button', { name: 'Export CSV' }));
        const csv = await blobs[0].text();
        expect(csv.split('\n')[0]).toBe('name,owner,audience,created_at,last_used_at,people,uses,ai_cost');
    });

    it('says so when the items cannot be read', async () => {
        install({ 'GET /api/usage/adoption/studio/items': () => new Response('{}', { status: 500 }) });
        const agent = kinds().find(k => k.kind === 'agent')!;
        renderWithClient(<StudioDrilldown kind={agent} qs="days=30" currency="€" scopeLabel="" />);
        expect(await screen.findByText('The items of this kind could not be read.')).toBeTruthy();
    });
});
