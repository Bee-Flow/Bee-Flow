import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GrantsTable, type Grant } from './GrantsTable';

const grants: Grant[] = [
    { id: 'g1', organizationId: 'o1', organizationName: 'Beta', tier: 'business', refreshStatus: 'active', expiresAt: '2027-03-01', blob: 'b1', metadata: { admin_notes: 'pilot' } },
    { id: 'g2', organizationId: 'o2', organizationName: 'Acme', tier: 'team', refreshStatus: 'revoked', expiresAt: '2026-12-01', blob: 'b2' },
    { id: 'g3', scope: 'server', tier: 'enterprise', refreshStatus: 'active', expiresAt: '2028-01-01', blob: '' },
];

const names = () => screen.getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[0].textContent);

describe('GrantsTable', () => {
    it('lists the grants as a table, with the actions a grant still has', async () => {
        const onRevoke = vi.fn();
        render(<GrantsTable grants={grants} onCopy={vi.fn()} onExtend={vi.fn()} onRevoke={onRevoke} />);
        expect(screen.getByRole('table', { name: 'Admin License Grants' })).toBeInTheDocument();
        expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Organization', 'Tier', 'Status', 'Issued', 'Expires', 'Notes', 'Actions']);
        expect(screen.getByText('Server license')).toBeInTheDocument();
        // A revoked grant can still be copied, not extended or revoked again.
        expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: 'Copy blob' })).toHaveLength(2);
        await userEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]);
        expect(onRevoke).toHaveBeenCalledWith(grants[0]);
    });

    it('sorts on a click of a header, descending first', async () => {
        render(<GrantsTable grants={grants} onCopy={vi.fn()} onExtend={vi.fn()} onRevoke={vi.fn()} />);
        expect(names()[0]).toContain('Beta');
        await userEvent.click(screen.getByRole('button', { name: 'Expires' }));
        expect(screen.getByRole('columnheader', { name: 'Expires' })).toHaveAttribute('aria-sort', 'descending');
        expect(names()[0]).toContain('Server license');
        await userEvent.click(screen.getByRole('button', { name: 'Expires' }));
        expect(names()[0]).toContain('Acme');
    });
});
