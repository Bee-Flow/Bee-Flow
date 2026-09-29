import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';

/**
 * The stretch between two pages of a form: the routine is running and the
 * visitor is looking at a page that can only poll.
 *
 * Characterisation only (FRM-0). Three things are pinned here that the
 * existing suite does not reach: what the wait actually SHOWS while it lasts,
 * what happens when it lasts longer than the page is willing to wait, and that
 * "check again" resumes the same journey rather than starting a new one.
 */

const { default: PublicFormPage } = await import('./PublicFormPage');

const TOKEN = 'a'.repeat(48);
const SESSION = 'c'.repeat(48);
const FORM = {
    title: 'Contact us',
    description: '',
    submitLabel: 'Send it',
    successMessage: 'Thanks — we got your answer.',
    multiPage: true,
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
    fields: [{ name: 'email', type: 'email', label: 'Your email', required: true }],
};

function mockFetch(handlers) {
    return vi.fn(async (url, init = {}) => {
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

async function submitPageOne() {
    await screen.findByText('Contact us');
    fireEvent.change(screen.getByLabelText(/Your email/), { target: { value: 'a@b.nl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send it' }));
}

describe('PublicFormPage — while the routine works', () => {
    beforeEach(() => {
        cleanup();
        document.documentElement.removeAttribute('data-theme');
        window.history.replaceState(null, '', `/f/${TOKEN}`);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('shows a working card the moment the answers are accepted, before any poll comes back', async () => {
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`GET /${TOKEN}/s/${SESSION}`]: async () => ({ body: { state: 'working' } }),
        }));
        render(<PublicFormPage token={TOKEN} />);
        await submitPageOne();

        const card = await screen.findByTestId('form-waiting');
        expect(card.getAttribute('aria-live')).toBe('polite');
        expect(card.textContent).toContain('This can take a moment.');
        // The form is gone while the run has it.
        expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull();
    });

    it('names the step the routine is on, with the flowlet above it as context', async () => {
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`GET /${TOKEN}/s/${SESSION}`]: async () => ({
                body: {
                    state: 'working',
                    progress: ['Offerte-controle', 'Zoek de vergelijkbare offertes'],
                    progressNote: 'Searches for comparable quotes and lets AI weigh them.',
                },
            }),
        }));
        render(<PublicFormPage token={TOKEN} />);
        await submitPageOne();

        expect(await screen.findByText('Zoek de vergelijkbare offertes', {}, { timeout: 4000 })).toBeTruthy();
        expect(screen.getByText('Offerte-controle')).toBeTruthy();
        expect(screen.getByTestId('form-waiting-note').textContent)
            .toBe('Searches for comparable quotes and lets AI weigh them.');
    });

    it('keeps the last known step on screen when a later poll sends no trail at all', async () => {
        let call = 0;
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`GET /${TOKEN}/s/${SESSION}`]: async () => {
                call += 1;
                return { body: call === 1 ? { state: 'working', progress: ['Zoeken'] } : { state: 'working' } };
            },
        }));
        render(<PublicFormPage token={TOKEN} />);
        await submitPageOne();

        await screen.findByText('Zoeken', {}, { timeout: 4000 });
        await waitFor(() => expect(call).toBeGreaterThan(1), { timeout: 4000 });
        // Blanking it between steps would read as the page losing its place.
        expect(screen.getByText('Zoeken')).toBeTruthy();
    });

    it('gives up after five minutes and offers to check again by hand', async () => {
        // Time is moved rather than the timers: the poll loop awaits a fetch,
        // so a timer-only clock never reaches the ceiling check.
        const realNow = Date.now;
        let skew = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + skew);

        let polls = 0;
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`GET /${TOKEN}/s/${SESSION}`]: async () => {
                polls += 1;
                // One honest poll, then the wait outlasts the page's patience.
                if (polls === 1) skew = 6 * 60 * 1000;
                return { body: polls > 2 ? { state: 'done', ending: { title: 'All done', description: 'Ticket T-9' } } : { state: 'working' } };
            },
        }));
        render(<PublicFormPage token={TOKEN} />);
        await submitPageOne();

        expect(await screen.findByText('This is taking a while', {}, { timeout: 4000 })).toBeTruthy();
        expect(screen.getByText('Your answers were received — we are still working on them.')).toBeTruthy();
        const polled = polls;

        fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
        expect(await screen.findByText('All done', {}, { timeout: 4000 })).toBeTruthy();
        expect(polls).toBeGreaterThan(polled);
        // The same session, resumed — never a second submission of page one.
        expect(screen.queryByRole('button', { name: 'Send it' })).toBeNull();
    });

    it('stops polling once it has given up, rather than spinning at the visitor forever', async () => {
        const realNow = Date.now;
        let skew = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + skew);

        let polls = 0;
        vi.stubGlobal('fetch', mockFetch({
            ...load,
            ...accept,
            [`GET /${TOKEN}/s/${SESSION}`]: async () => {
                polls += 1;
                if (polls === 1) skew = 6 * 60 * 1000;
                return { body: { state: 'working' } };
            },
        }));
        render(<PublicFormPage token={TOKEN} />);
        await submitPageOne();
        await screen.findByText('This is taking a while', {}, { timeout: 4000 });

        const settled = polls;
        await new Promise(r => setTimeout(r, 1200));
        expect(polls).toBe(settled);
    });
});
