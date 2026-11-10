import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NcSignInFailedScreen } from './shellScreens';
import NcOnboardingPending from '../components/integrations/nextcloud/NcOnboardingPending';
import EN_DEFAULTS from '../i18n/en-defaults';

describe('NcSignInFailedScreen', () => {
    it('explains and retries, and offers no sign-in form', async () => {
        const onRetry = vi.fn();
        render(<NcSignInFailedScreen onRetry={onRetry} />);
        expect(screen.getByRole('heading', { name: 'Not signed in to Bee Flow' })).toBeTruthy();
        expect(screen.getByText(/signs you in with your Nextcloud account/)).toBeTruthy();
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(document.querySelector('input')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('offers the sign-in form as a second action when the caller wires one', async () => {
        const onUseAccount = vi.fn();
        const { unmount } = render(<NcSignInFailedScreen onRetry={() => {}} onUseAccount={onUseAccount} />);
        await userEvent.click(screen.getByRole('button', { name: 'Sign in with a Bee Flow account' }));
        expect(onUseAccount).toHaveBeenCalledTimes(1);
        unmount();
        render(<NcSignInFailedScreen onRetry={() => {}} />);
        expect(screen.queryByRole('button', { name: 'Sign in with a Bee Flow account' })).toBeNull();
    });

    it("shows the server's sentence when it answered one", () => {
        render(<NcSignInFailedScreen message="Ask your Bee Flow administrator to invite you." onRetry={() => {}} />);
        expect(screen.getByText('Ask your Bee Flow administrator to invite you.')).toBeTruthy();
        expect(screen.queryByText(/signs you in with your Nextcloud account/)).toBeNull();
    });
});

describe('the texts of the signed-out Nextcloud screens', () => {
    it('are in the English dictionary', () => {
        for (const key of [
            'app.nc_sign_in_failed_title',
            'app.nc_sign_in_failed_body',
            'app.nc_sign_in_failed_retry',
            'app.nc_sign_in_failed_use_account',
            'integ.nc_onboarding_pending_setup_in_progress',
            'integ.nc_onboarding_pending_refresh',
        ]) {
            expect(typeof (EN_DEFAULTS as Record<string, unknown>)[key], key).toBe('string');
        }
    });

    it('the pending screen renders text, not keys', () => {
        render(<NcOnboardingPending onRefresh={() => {}} />);
        expect(screen.getByRole('heading', { name: 'Setup in progress' })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/integ\.|app\./);
    });
});
