import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import type { AdoptionGroups } from './adoption.types';
import GroupsTable from './GroupsTable';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const groups = () => (ROUTES as unknown as Record<string, Handler>)['GET /api/usage/adoption/groups']({ state: createState(), query: new URLSearchParams() }) as AdoptionGroups;

describe('GroupsTable', () => {
    it('lists every group and the folded small groups last', () => {
        render(<GroupsTable data={groups()} currency="€" />);
        const heads = screen.getAllByRole('rowheader').map(h => h.textContent);
        expect(heads[0]).toContain('Sales');
        expect(heads[0]).toContain('Entra ID');
        expect(heads[heads.length - 1]).toContain('Other groups (3)');
        expect(heads[heads.length - 1]).toContain('fewer than 5 members each');
    });

    it('shows adoption, spend and the area used most', () => {
        render(<GroupsTable data={groups()} currency="€" />);
        const sales = screen.getAllByRole('row')[1];
        expect(sales.textContent).toContain('88%');
        expect(sales.textContent).toContain('€402.00');
        expect(sales.textContent).toContain('Agents');
    });

    it('says so when there are no groups', () => {
        render(<GroupsTable data={{ groups: [], folded: null, partial: false }} currency="€" />);
        expect(screen.getByText('No groups in this organisation yet.')).toBeTruthy();
    });
});
