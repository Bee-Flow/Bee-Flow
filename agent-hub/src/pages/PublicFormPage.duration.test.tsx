import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';

/**
 * While the automation works, the poll may say how long runs of this form
 * usually take. The page keeps that number for the wait and drops it when the
 * journey moves on to a question or the end.
 */

const { default: PublicFormPage } = await import('./PublicFormPage');

const TOKEN = 'a'.repeat(48);
const SESSION = 'c'.repeat(48);
const FORM = {
    title: 'Contact us',
    description: '',
    submitLabel: 'Send it',
    successMessage: 'Thanks',
    multiPage: true,
    theme: { appearance: 'light' },
    fields: [{ name: 'email', type: 'email', label: 'Your email', required: true }],
};

type Handler = (init: RequestInit) => Promise<{ ok?: boolean; status?: number; body?: unknown }>;

function mockFetch(handlers: Record<string, Handler>) {
    return vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        const key = `${method} ${String(url).replace(/^.*\/api\/automation\/form/, '')}`;
        const h = handlers[key];
        if (!h) throw new Error(`unmocked fetch: ${key}`);
        const r = await h(init);
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body ?? {} };
    });
}

const load = { [`GET /${TOKEN}`]: async () => ({ body: { form: FORM, csrf: 'csrf-1', issuedAt: Date.now() - 10_000 } }) };
const accept = { [`POST /${TOKEN}`]: async () => ({ status: 202, body: { accepted: true, sessionId: SESSION } }) };

describe('PublicFormPage — how long the wait usually is', () => {
    beforeEach(() => {
        cleanup();
        document.documentElement.removeAttribute('data-theme');
        window.history.replaceState(null, '', `/f/${TOKEN}`);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('shows the typical length from a working poll', async () => {
        const user = userEvent.setup();
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`GET /${TOKEN}/s/${SESSION}`]: async () => ({ body: { state: 'working', progress: ['Step one'], typicalSeconds: 150 } }),
        }));
        render(<PublicFormPage token={TOKEN} webpagesEnabled={false} />);
        await user.type(await screen.findByLabelText(/Your email/), 'a@example.test');
        await user.click(screen.getByRole('button', { name: 'Send it' }));

        expect((await screen.findByTestId('form-waiting-typical', {}, { timeout: 4000 })).textContent).toBe('Usually takes about 3 minutes');
    });

    it('shows no line when the poll never says', async () => {
        const user = userEvent.setup();
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`GET /${TOKEN}/s/${SESSION}`]: async () => ({ body: { state: 'working', progress: ['Step one'] } }),
        }));
        render(<PublicFormPage token={TOKEN} webpagesEnabled={false} />);
        await user.type(await screen.findByLabelText(/Your email/), 'a@example.test');
        await user.click(screen.getByRole('button', { name: 'Send it' }));

        await screen.findByText('Step one', {}, { timeout: 4000 });
        expect(screen.queryByTestId('form-waiting-typical')).toBeNull();
    });

    it('shows it at once when a reload lands on a session that is still working', async () => {
        window.history.replaceState(null, '', `/f/${TOKEN}?s=${SESSION}`);
        vi.stubGlobal('fetch', mockFetch({
            [`GET /${TOKEN}/s/${SESSION}`]: async () => ({ body: { state: 'working', typicalSeconds: 20 } }),
        }));
        render(<PublicFormPage token={TOKEN} webpagesEnabled={false} />);
        expect((await screen.findByTestId('form-waiting-typical')).textContent).toBe('Usually takes less than a minute');
    });

    it('drops it when the journey reaches a question, and does not carry it into the next wait', async () => {
        const user = userEvent.setup();
        let polls = 0;
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`POST /${TOKEN}/s/${SESSION}`]: async () => ({ status: 202, body: { accepted: true } }),
            [`GET /${TOKEN}/s/${SESSION}`]: async () => {
                polls += 1;
                if (polls === 1) return { body: { state: 'working', typicalSeconds: 100 } };
                if (polls === 2) {
                    return { body: { state: 'form', csrf: 'csrf-2', issuedAt: Date.now(), form: { ...FORM, title: 'Page two', fields: [{ name: 'note', type: 'text', label: 'A note' }] } } };
                }
                return { body: { state: 'working' } };
            },
        }));
        render(<PublicFormPage token={TOKEN} webpagesEnabled={false} />);
        await user.type(await screen.findByLabelText(/Your email/), 'a@example.test');
        await user.click(screen.getByRole('button', { name: 'Send it' }));

        await screen.findByTestId('form-waiting-typical', {}, { timeout: 4000 });
        await screen.findByText('Page two', {}, { timeout: 6000 });
        expect(screen.queryByTestId('form-waiting-typical')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Send it' }));
        await screen.findByTestId('form-waiting');
        await waitFor(() => expect(polls).toBeGreaterThan(2), { timeout: 4000 });
        expect(screen.queryByTestId('form-waiting-typical')).toBeNull();
    });
});
