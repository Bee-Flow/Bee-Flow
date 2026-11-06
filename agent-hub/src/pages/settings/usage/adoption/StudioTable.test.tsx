import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoTransport, type DemoRoutes } from '@/demo/demoTransport';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import { renderWithClient } from '@/test/render';
import { setDemoTransport } from '@/utils/helpers';
import type { AdoptionStudio } from './adoption.types';
import StudioTable from './StudioTable';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const studio = () => (ROUTES as unknown as Record<string, Handler>)['GET /api/usage/adoption/studio']({ state: createState(), query: new URLSearchParams() }) as AdoptionStudio;

const rowOf = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) }).closest('tr') as HTMLElement;

function renderTable(kinds = studio().kinds, compare = true) {
    setDemoTransport(createDemoTransport(ROUTES as unknown as DemoRoutes, createState()));
    return renderWithClient(<StudioTable kinds={kinds} currency="€" qs="days=30" scopeLabel="all groups" compare={compare} />);
}

afterEach(() => { setDemoTransport(null); });

describe('StudioTable', () => {
    it('lists one row per kind the organisation has, with its usage noun', () => {
        renderTable();
        expect(screen.getAllByRole('row')).toHaveLength(14);
        const agents = rowOf('Agents');
        expect(agents.textContent).toContain('42');
        expect(agents.textContent).toContain('conversations');
        expect(agents.textContent).toContain('€526.00');
    });

    it('renders "no signal" for a kind nothing records the use of, never a zero', () => {
        renderTable();
        const kb = rowOf('Knowledge bases');
        expect(within(kb).getAllByText('no signal')).toHaveLength(2);
        expect(kb.textContent).toContain('no usage signal');
    });

    it('hides a kind with nothing in it', () => {
        renderTable(studio().kinds.map(k => (k.kind === 'playbook' ? { ...k, total: 0 } : k)));
        expect(screen.queryByRole('button', { name: /^Playbooks/ })).toBeNull();
    });

    it('shows the trend change as a pill, and hides it with compare off', () => {
        const { unmount } = renderTable();
        expect(screen.getAllByTestId('delta-pill').length).toBeGreaterThan(0);
        unmount();
        renderTable(studio().kinds, false);
        expect(screen.queryAllByTestId('delta-pill')).toHaveLength(0);
    });

    it('filters by rail group and by a search over the kind names', async () => {
        const user = userEvent.setup();
        renderTable();
        await user.click(screen.getByRole('button', { name: 'Bundle' }));
        expect(screen.getAllByRole('row')).toHaveLength(3);
        await user.click(screen.getByRole('button', { name: /^All kinds/ }));
        await user.type(screen.getByRole('searchbox', { name: 'Search kinds' }), 'agent');
        expect(screen.getAllByRole('row')).toHaveLength(2);
        expect(screen.getByRole('button', { name: /^Agents/ })).toBeTruthy();
    });

    it('opens a kind in a full-width row directly under it, and closes it again', async () => {
        const user = userEvent.setup();
        renderTable();
        const button = screen.getByRole('button', { name: /^Agents/ });
        expect(button.getAttribute('aria-expanded')).toBe('false');
        await user.click(button);
        expect(button.getAttribute('aria-expanded')).toBe('true');
        const rows = screen.getAllByRole('row');
        const own = rows.indexOf(rowOf('Agents'));
        const panel = rows[own + 1];
        expect(panel.querySelector('td')?.getAttribute('colspan')).toBe('8');
        expect(await within(panel).findByText('Agents · 42 in the organisation')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /^Automations/ }));
        expect(button.getAttribute('aria-expanded')).toBe('false');
        await user.click(screen.getByRole('button', { name: /^Automations/ }));
        expect(screen.queryAllByRole('region')).toHaveLength(0);
    });
});
