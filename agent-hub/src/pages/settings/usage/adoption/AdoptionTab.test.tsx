/**
 * The Adoption tab end to end over the demo fixtures (the contract's shapes):
 * every section renders, the group filter narrows every read, people are
 * pseudonymous until "Reveal names", a reveal the audit log refused shows
 * nothing, and the CSV export carries names only while they are revealed.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import { deriveRangeParams } from '@/utils/usageHelpers';
import AdoptionTab, { adoptionQuery } from './AdoptionTab';

const seen: URL[] = [];

const BASE_ROUTES = ROUTES as unknown as DemoRoutes;

function install(overrides: DemoRoutes = {}) {
    const transport = createDemoTransport({ ...BASE_ROUTES, ...overrides }, createState());
    setDemoTransport(async (url: unknown, options?: RequestInit) => {
        seen.push(new URL(String(url), 'http://x'));
        return transport(url, options);
    });
}

const range = deriveRangeParams({ preset: '30d' });

/** The member cells of the people table (the one with a "Member" column). */
function memberCells(): string[] {
    const table = screen.getAllByRole('table').find(tb => within(tb).queryByRole('columnheader', { name: 'Member' }));
    return table ? within(table).queryAllByRole('rowheader').map(h => h.textContent || '') : [];
}
const renderTab = () => renderWithClient(<AdoptionTab rangeParams={range} rangePreset="30d" showTokens currency="€" />);

beforeEach(() => { seen.length = 0; });
afterEach(() => { setDemoTransport(null); vi.restoreAllMocks(); });

describe('adoptionQuery', () => {
    it('sends a preset as days, a custom range as an absolute window, and the group', () => {
        expect(adoptionQuery(range, '30d', '')).toBe('days=30');
        expect(adoptionQuery(deriveRangeParams({ preset: 'all' }), 'all', 'g1')).toBe('days=3650&group=g1');
        const custom = deriveRangeParams({ preset: 'custom', customStart: '2026-10-01T00:00:00Z', customEnd: '2026-10-31T00:00:00Z' });
        const qs = new URLSearchParams(adoptionQuery(custom, 'custom', ''));
        expect(qs.get('startDate')).toBe('2026-10-01T00:00:00.000Z');
        expect(qs.has('days')).toBe(false);
    });
});

describe('AdoptionTab', () => {
    it('renders the hero, the areas, the Studio table, the groups, the people and the notes', async () => {
        install();
        renderTab();
        expect(await screen.findByText('72%')).toBeTruthy();
        expect(screen.getByText('107 of 148 members used AI')).toBeTruthy();
        expect(screen.getByText('Where the AI goes')).toBeTruthy();
        expect(screen.getByRole('img', { name: 'AI spend per week, by area' })).toBeTruthy();
        expect(screen.getByText('Studio adoption')).toBeTruthy();
        expect(await screen.findByText('Adoption by group')).toBeTruthy();
        expect(screen.getByText('Other groups (3)')).toBeTruthy();
        expect(await screen.findByText('Names are hidden')).toBeTruthy();
        expect(screen.getByText('Who can see this')).toBeTruthy();
        expect(screen.getByText('Growing')).toBeTruthy();
    });

    it('narrows every read to the chosen group', async () => {
        install();
        const user = userEvent.setup();
        renderTab();
        await screen.findByText('72%');
        await user.selectOptions(screen.getByLabelText('Group'), 'grp_demo_hr');
        await waitFor(() => expect(seen.some(u => u.pathname.endsWith('/people') && u.searchParams.get('group') === 'grp_demo_hr')).toBe(true));
        for (const route of ['summary', 'areas', 'studio']) {
            expect(seen.some(u => u.pathname.endsWith(`/adoption/${route}`) && u.searchParams.get('group') === 'grp_demo_hr')).toBe(true);
        }
    });

    it('reveals names on one click, says it was recorded, and hides them again', async () => {
        install();
        const user = userEvent.setup();
        renderTab();
        const table = await screen.findByText('Names are hidden');
        expect(table).toBeTruthy();
        expect((await screen.findAllByText(/^Member · /)).length).toBeGreaterThan(0);
        expect(seen.some(u => u.searchParams.get('reveal') === 'true')).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        expect(await screen.findByText('Names shown · recorded in the access audit log')).toBeTruthy();
        expect(seen.filter(u => u.searchParams.get('reveal') === 'true').length).toBe(1);
        await waitFor(() => expect(screen.queryAllByText(/^Member · /).length).toBe(0));
        await user.click(screen.getByRole('button', { name: 'Hide names' }));
        expect(await screen.findByText('Names are hidden')).toBeTruthy();
        expect((await screen.findAllByText(/^Member · /)).length).toBeGreaterThan(0);
    });

    it('never shows the revealed names as a placeholder once they are hidden again, also after a group change', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        install({
            'GET /api/usage/adoption/people': async (ctx) => {
                const q = ctx.query;
                if (q?.get('group') === 'grp_demo_hr' && q.get('reveal') !== 'true') await held;
                return BASE_ROUTES['GET /api/usage/adoption/people'](ctx);
            },
        });
        const user = userEvent.setup();
        renderTab();
        await screen.findAllByText(/^Member · /);
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        await screen.findByText('Names shown · recorded in the access audit log');
        await user.selectOptions(screen.getByLabelText('Group'), 'grp_demo_hr');
        await waitFor(() => expect(seen.some(u => u.searchParams.get('group') === 'grp_demo_hr' && u.searchParams.get('reveal') === 'true')).toBe(true));
        await waitFor(() => expect(memberCells().length).toBeGreaterThan(0));
        expect(memberCells().some(n => n.startsWith('Member · '))).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Hide names' }));
        expect(await screen.findByText('Names are hidden')).toBeTruthy();
        expect(memberCells().every(n => n.startsWith('Member · '))).toBe(true);
        release();
        await waitFor(() => expect(memberCells().length).toBeGreaterThan(0));
        expect(memberCells().every(n => n.startsWith('Member · '))).toBe(true);
    });

    it('asks the server again, and so records again, on every "Reveal names"', async () => {
        install();
        const user = userEvent.setup();
        renderTab();
        await screen.findAllByText(/^Member · /);
        const reveals = () => seen.filter(u => u.searchParams.get('reveal') === 'true').length;
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        await screen.findByText('Names shown · recorded in the access audit log');
        expect(reveals()).toBe(1);
        await user.click(screen.getByRole('button', { name: 'Hide names' }));
        await screen.findByText('Names are hidden');
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        await screen.findByText('Names shown · recorded in the access audit log');
        await waitFor(() => expect(reveals()).toBe(2));
    });

    it('shows nothing when the audit log could not record the reveal', async () => {
        install({
            'GET /api/usage/adoption/people': (ctx) => (ctx.query?.get('reveal') === 'true'
                ? new Response(JSON.stringify({ code: 'audit_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
                : BASE_ROUTES['GET /api/usage/adoption/people'](ctx)),
        });
        const user = userEvent.setup();
        renderTab();
        await screen.findByText('Names are hidden');
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        expect(await screen.findByText('Names not revealed')).toBeTruthy();
        expect(screen.getByText('Nothing is shown.')).toBeTruthy();
        expect(screen.queryAllByText(/^Member · /).length).toBe(0);
        await user.click(screen.getByRole('button', { name: /Back to pseudonyms/ }));
        expect((await screen.findAllByText(/^Member · /)).length).toBeGreaterThan(0);
    });

    it('exports a CSV with pseudonyms, and with names only after a reveal', async () => {
        install();
        const user = userEvent.setup();
        const blobs: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        renderTab();
        await screen.findAllByText(/^Member · /);
        await user.click(screen.getByRole('button', { name: 'Export CSV' }));
        const first = await blobs[0].text();
        expect(first).toContain('# people (pseudonymous)');
        expect(first).toMatch(/Member · [A-Z2-9]{4}/);
        expect(first).not.toMatch(/Alex Morgan/);
        await user.click(screen.getByRole('button', { name: 'Reveal names' }));
        await screen.findByText('Names shown · recorded in the access audit log');
        await user.click(screen.getByRole('button', { name: 'Export CSV' }));
        const second = await blobs[1].text();
        expect(second).toContain('# people (names revealed');
        expect(second).not.toMatch(/Member · [A-Z2-9]{4}/);
    });

    it('opens a kind\'s drill-down from the Studio table with Enter', async () => {
        install();
        const user = userEvent.setup();
        renderTab();
        const open = await screen.findByRole('button', { name: 'Open Agents' });
        open.focus();
        await user.keyboard('{Enter}');
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Agents · 42 in the organisation')).toBeTruthy();
        expect(await within(dialog).findByText('Who uses it most')).toBeTruthy();
    });

    it('says so when the report cannot be read', async () => {
        install({ 'GET /api/usage/adoption/summary': () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) });
        renderTab();
        expect(await screen.findByText(/The adoption report could not be read/)).toBeTruthy();
    });
});
