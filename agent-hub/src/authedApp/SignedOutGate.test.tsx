/**
 * Without a session inside Nextcloud the person first gets the state of the
 * connector's sign-in, with the sign-in form one action away; standalone the
 * form is the screen.
 */
import React, { Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedOutGate } from './SignedOutGate';

const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);

function gate(props: Partial<React.ComponentProps<typeof SignedOutGate>>) {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <Suspense fallback={null}>
                <SignedOutGate ncOnboardingState={null} ncOrgName={null} bootstrapDiagnostics={null} signInRefusal={null} onLogin={() => {}} t={t} {...props} />
            </Suspense>
        </QueryClientProvider>,
    );
}

const passwordField = () => document.querySelector('input[type="password"]');

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('SignedOutGate inside Nextcloud', () => {
    it('pending onboarding: the setup-in-progress screen, no form', async () => {
        gate({ embedded: true, ncOnboardingState: 'pending' });
        expect(await screen.findByRole('heading', { name: 'Setup in progress' })).toBeTruthy();
        expect(screen.getByText(/Your administrator is finalising the Bee Flow configuration/)).toBeTruthy();
        expect(document.querySelector('input')).toBeNull();
    });

    it('a failed sign-in: the explanation with a retry, no form', async () => {
        gate({ embedded: true, signInRefusal: { status: 502, code: null, message: null } });
        expect(await screen.findByRole('heading', { name: 'Not signed in to Bee Flow' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
        expect(document.querySelector('input')).toBeNull();
    });

    it("a refusal meant for this person shows the server's sentence", async () => {
        gate({ embedded: true, signInRefusal: { status: 403, code: null, message: 'Ask your Bee Flow administrator to invite you.' } });
        expect(await screen.findByText('Ask your Bee Flow administrator to invite you.')).toBeTruthy();
        expect(document.querySelector('input')).toBeNull();
    });

    it('a person with a Bee Flow account of their own reaches the sign-in form', async () => {
        const message = 'Your Bee Flow account is not a member of the organisation this Nextcloud is connected to. Sign in to Bee Flow directly, or ask an admin of that organisation to add your account.';
        gate({ embedded: true, signInRefusal: { status: 403, code: 'NC_ORG_MISMATCH', message } });
        expect(await screen.findByText(message)).toBeTruthy();
        expect(passwordField()).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Sign in with a Bee Flow account' }));
        await vi.waitFor(() => expect(passwordField()).not.toBeNull(), { timeout: 10_000 });
        expect(screen.queryByRole('heading', { name: 'Not signed in to Bee Flow' })).toBeNull();
    });

    it('the action is there without an answer from the server too (after signing out)', async () => {
        gate({ embedded: true, signInRefusal: null });
        expect(await screen.findByRole('button', { name: 'Sign in with a Bee Flow account' })).toBeTruthy();
    });

    it('pending onboarding and e-mail verification do not offer it', async () => {
        const pending = gate({ embedded: true, ncOnboardingState: 'pending' });
        expect(await screen.findByRole('heading', { name: 'Setup in progress' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Sign in with a Bee Flow account' })).toBeNull();
        pending.unmount();
        gate({ embedded: true, bootstrapDiagnostics: { state: 'awaiting_email_verification' } });
        await vi.waitFor(() => expect(document.querySelector('input')).not.toBeNull(), { timeout: 10_000 });
        expect(screen.queryByRole('button', { name: 'Sign in with a Bee Flow account' })).toBeNull();
        expect(passwordField()).toBeNull();
    });
});

describe('SignedOutGate standalone', () => {
    it('offers the sign-in form', async () => {
        gate({ embedded: false, signInRefusal: { status: 401, code: null, message: null } });
        await vi.waitFor(() => expect(passwordField()).not.toBeNull(), { timeout: 10_000 });
        expect(screen.queryByRole('heading', { name: 'Not signed in to Bee Flow' })).toBeNull();
    });
});
