// The self-hosted ceiling is read-only: the licence tier the install runs at,
// with links to the one place the licence and the feature switches are
// changed (Whole server > Licence & features). Neither editor is embedded.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SelfHostedCeilingEditor from './SelfHostedCeilingEditor';
import { withQueryClient } from '@/test/queryWrapper';
import { withShell } from '@/test/shellProviders';

const navigate = vi.fn();

beforeEach(() => {
    navigate.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ serverLicense: { tier: 'enterprise', expiresAt: '2030-01-01T00:00:00Z' }, serverOverride: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    )));
});

describe('SelfHostedCeilingEditor', () => {
    it('shows the tier read-only and links to Licence & features', async () => {
        const user = userEvent.setup();
        render(withQueryClient(withShell(<SelfHostedCeilingEditor />, { onNavigate: navigate })));
        expect(await screen.findByText('Enterprise')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Apply server-wide licence/ })).toBeNull();
        expect(screen.queryByRole('switch')).toBeNull();
        await user.click(screen.getByRole('button', { name: /Manage licence/ }));
        expect(navigate).toHaveBeenCalledWith('admin/licenses');
        await user.click(screen.getByRole('button', { name: /Open feature switches/ }));
        expect(navigate).toHaveBeenCalledWith('admin/licenses/features');
    });
});
