import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import type { AdoptionStudio } from './adoption.types';
import StudioTable from './StudioTable';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const studio = () => (ROUTES as unknown as Record<string, Handler>)['GET /api/usage/adoption/studio']({ state: createState(), query: new URLSearchParams() }) as AdoptionStudio;

const rowOf = (label: string) => screen.getByRole('button', { name: `Open ${label}` }).closest('tr') as HTMLElement;

describe('StudioTable', () => {
    it('lists one row per kind the organisation has, with its usage noun', () => {
        render(<StudioTable kinds={studio().kinds} currency="€" onOpen={() => {}} />);
        expect(screen.getAllByRole('row')).toHaveLength(14);
        const agents = rowOf('Agents');
        expect(agents.textContent).toContain('42');
        expect(agents.textContent).toContain('conversations');
        expect(agents.textContent).toContain('€526.00');
    });

    it('renders "no signal" for a kind nothing records the use of, never a zero', () => {
        render(<StudioTable kinds={studio().kinds} currency="€" onOpen={() => {}} />);
        const kb = rowOf('Knowledge bases');
        expect(within(kb).getAllByText('no signal')).toHaveLength(2);
        expect(kb.textContent).toContain('no usage signal');
    });

    it('hides a kind with nothing in it', () => {
        const kinds = studio().kinds.map(k => (k.kind === 'playbook' ? { ...k, total: 0 } : k));
        render(<StudioTable kinds={kinds} currency="€" onOpen={() => {}} />);
        expect(screen.queryByRole('button', { name: 'Open Playbooks' })).toBeNull();
    });

    it('filters by rail group and opens a kind on click', async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn();
        render(<StudioTable kinds={studio().kinds} currency="€" onOpen={onOpen} />);
        await user.click(screen.getByRole('button', { name: 'Bundle' }));
        expect(screen.getAllByRole('row')).toHaveLength(3);
        await user.click(screen.getByRole('button', { name: 'Open Solutions' }));
        expect(onOpen).toHaveBeenCalledWith('solution');
        expect(onOpen).toHaveBeenCalledTimes(1);
    });
});
