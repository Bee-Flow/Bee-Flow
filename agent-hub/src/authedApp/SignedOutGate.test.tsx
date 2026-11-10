/**
 * Without a session inside Nextcloud the person gets the state of the
 * connector's sign-in, never the password form; standalone the form stays.
 */
import React, { Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
});

describe('SignedOutGate standalone', () => {
    it('offers the sign-in form', async () => {
        gate({ embedded: false, signInRefusal: { status: 401, code: null, message: null } });
        await vi.waitFor(() => expect(passwordField()).not.toBeNull(), { timeout: 10_000 });
        expect(screen.queryByRole('heading', { name: 'Not signed in to Bee Flow' })).toBeNull();
    });
});
