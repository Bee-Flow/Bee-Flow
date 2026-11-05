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
        renderWithClient(<StudioDrilldown kind={agent} qs="days=30" currency="€" scopeLabel="6 Oct – 5 Nov 2026 · all groups" onClose={() => {}} />);
        const dialog = await screen.findByRole('dialog');
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
        renderWithClient(<StudioDrilldown kind={kb} qs="days=30" currency="€" scopeLabel="" onClose={() => {}} />);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getAllByText('no signal').length).toBe(2);
    });

    it('filters to the unused items, exports its items, and closes', async () => {
        install();
        const user = userEvent.setup();
        const onClose = vi.fn();
        const blobs: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const agent = kinds().find(k => k.kind === 'agent')!;
        renderWithClient(<StudioDrilldown kind={agent} qs="days=30" currency="€" scopeLabel="" onClose={onClose} />);
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByText('All items · 42');
        await user.click(within(dialog).getByRole('button', { name: /^Unused/ }));
        const rows = within(dialog).getAllByRole('row').slice(1);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(25);
        await user.click(within(dialog).getByRole('button', { name: 'Export CSV' }));
        const csv = await blobs[0].text();
        expect(csv.split('\n')[0]).toBe('name,owner,audience,created_at,last_used_at,people,uses,ai_cost');
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalled();
    });

    it('says so when the items cannot be read', async () => {
        install({ 'GET /api/usage/adoption/studio/items': () => new Response('{}', { status: 500 }) });
        const agent = kinds().find(k => k.kind === 'agent')!;
        renderWithClient(<StudioDrilldown kind={agent} qs="days=30" currency="€" scopeLabel="" onClose={() => {}} />);
        expect(await screen.findByText('The items of this kind could not be read.')).toBeTruthy();
    });
});
