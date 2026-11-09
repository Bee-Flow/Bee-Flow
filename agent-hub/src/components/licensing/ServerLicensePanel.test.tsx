import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ServerLicensePanel from './ServerLicensePanel';
import { withQueryClient } from '@/test/queryWrapper';

function answerStatus(status: object) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } })));
}

beforeEach(() => answerStatus({}));

describe('ServerLicensePanel', () => {
    it('without a server-wide licence: says so and offers to apply one in a labelled field', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<ServerLicensePanel />));
        expect(await screen.findByRole('heading', { name: 'No server-wide licence applied' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Server licence' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Deactivate/ })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Apply server-wide licence/ }));
        const field = screen.getByLabelText('Activate server-wide');
        expect(screen.getByRole('button', { name: 'Activate server-wide' })).toBeDisabled();
        await user.type(field, 'eyJ.token');
        expect(screen.getByRole('button', { name: 'Activate server-wide' })).toBeEnabled();
    });

    it('with one: shows its tier, issuer and billing, offers replace and deactivate, and notes when it does not govern', async () => {
        answerStatus({ serverLicense: { tier: 'enterprise', issuer: 'licence.beeflow', billingInterval: 'yearly', expiresAt: null }, serverOverride: false });
        render(withQueryClient(<ServerLicensePanel />));
        expect(await screen.findByRole('heading', { name: 'Server-wide licence active' })).toBeInTheDocument();
        expect(screen.getByText('Enterprise')).toBeInTheDocument();
        expect(screen.getByText('licence.beeflow')).toBeInTheDocument();
        expect(screen.getByText('yearly')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Replace licence/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
        expect(screen.getByText(/does not cover organisations on this deployment/)).toBeInTheDocument();
    });
});
