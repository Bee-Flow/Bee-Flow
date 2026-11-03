import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A journey that waits on a person's decision (WI-12, D4c). The poll answers
 * `waiting_decision`: the page stops polling at once (no five-minute spinner
 * ending in "taking a while"), says the visitor may close it, and shows the
 * address that brings them back (the session sits in ?s=). Revisiting that
 * address, or "Check again", picks the journey up where it is now.
 *
 * And a test journey keeps its Test banner after a reload with ?s=, because
 * the poll says `test: true` (the page never reads GET /form/:token then).
 */

const { default: PublicFormPage } = await import('./PublicFormPage');

const TOKEN = 'a'.repeat(48);
const SESSION = 'c'.repeat(48);
const PAGE_2 = {
    title: 'Nearly there',
    submitLabel: 'Finish',
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
    fields: [{ name: 'address', type: 'text', label: 'Your address', required: true }],
};

type Reply = { ok?: boolean; status?: number; body?: unknown };

/** Every GET of the session answers the next reply in line (the last one repeats). */
function sessionFetch(replies: Reply[]) {
    const calls: string[] = [];
    const fn = vi.fn(async (url: unknown) => {
        const path = String(url).replace(/^.*\/api\/automation\/form/, '');
        calls.push(path);
        if (path !== `/${TOKEN}/s/${SESSION}`) throw new Error(`unmocked fetch: ${path}`);
        const r = replies.length > 1 ? replies.shift()! : replies[0];
        return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body ?? {} };
    });
    return { fn, calls };
}

describe('PublicFormPage — waiting on a decision', () => {
    beforeEach(() => {
        cleanup();
        document.documentElement.removeAttribute('data-theme');
        window.history.replaceState(null, '', `/f/${TOKEN}?s=${SESSION}`);
    });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('stops polling, says the visitor may close the page, and shows the address to come back to', async () => {
        const { fn, calls } = sessionFetch([
            { body: { state: 'working' } },
            { body: { state: 'waiting_decision', notify: true } },
        ]);
        vi.stubGlobal('fetch', fn);
        render(<PublicFormPage token={TOKEN} />);

        const view = await screen.findByTestId('form-waiting-decision', {}, { timeout: 3000 });
        expect(view.textContent).toContain('A person needs to review this. You can close this page; we will send you a link when the next page is ready.');
        expect(screen.getByTestId('form-resume-link').textContent).toBe(`${window.location.origin}/f/${TOKEN}?s=${SESSION}`);
        expect(screen.queryByTestId('form-waiting')).toBeNull();

        // No further poll: wait well past the next tick and count.
        const polled = calls.length;
        await new Promise(r => setTimeout(r, 1500));
        expect(calls.length).toBe(polled);
        expect(screen.queryByText('This is taking a while')).toBeNull();
    });

    it('without a known submitter it promises no message, only the link', async () => {
        const { fn } = sessionFetch([{ body: { state: 'waiting_decision', notify: false } }]);
        vi.stubGlobal('fetch', fn);
        render(<PublicFormPage token={TOKEN} />);
        const view = await screen.findByTestId('form-waiting-decision');
        expect(view.textContent).toContain('come back to it later with the link below');
        expect(view.textContent).not.toContain('we will send you a link');
    });

    it('a revisit after the decision opens the next page; "Check again" does the same in place', async () => {
        // The revisit: the link from the mail, after the approval.
        let f = sessionFetch([{ body: { state: 'form', form: PAGE_2, csrf: 'c2', issuedAt: Date.now() } }]);
        vi.stubGlobal('fetch', f.fn);
        render(<PublicFormPage token={TOKEN} />);
        expect(await screen.findByText('Nearly there')).toBeTruthy();
        cleanup();
        vi.unstubAllGlobals();

        // In place: still waiting, then the visitor checks again after the decision.
        f = sessionFetch([
            { body: { state: 'waiting_decision', notify: true } },
            { body: { state: 'form', form: PAGE_2, csrf: 'c2', issuedAt: Date.now() } },
        ]);
        vi.stubGlobal('fetch', f.fn);
        const user = userEvent.setup();
        render(<PublicFormPage token={TOKEN} />);
        await screen.findByTestId('form-waiting-decision');
        await user.click(screen.getByRole('button', { name: 'Check again' }));
        expect(await screen.findByText('Nearly there', {}, { timeout: 3000 })).toBeTruthy();
    });

    it('copies the address to come back to', async () => {
        const { fn } = sessionFetch([{ body: { state: 'waiting_decision', notify: true } }]);
        vi.stubGlobal('fetch', fn);
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        render(<PublicFormPage token={TOKEN} />);
        await screen.findByTestId('form-waiting-decision');
        await user.click(screen.getByRole('button', { name: 'Copy link' }));
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/f/${TOKEN}?s=${SESSION}`);
        expect(await screen.findByRole('button', { name: 'Link copied' })).toBeTruthy();
    });

    it('a test journey keeps its Test banner after a reload with ?s=', async () => {
        const { fn, calls } = sessionFetch([{ body: { state: 'waiting_decision', notify: true, test: true } }]);
        vi.stubGlobal('fetch', fn);
        render(<PublicFormPage token={TOKEN} />);
        await screen.findByTestId('form-waiting-decision');
        expect(screen.getByTestId('form-test-banner')).toBeTruthy();
        // It never asked GET /form/:token.
        expect(calls.every(c => c.includes('/s/'))).toBe(true);
        await waitFor(() => expect(screen.getByTestId('form-test-banner')).toBeTruthy());
    });

    it('a production journey shows no banner', async () => {
        const { fn } = sessionFetch([{ body: { state: 'waiting_decision', notify: true } }]);
        vi.stubGlobal('fetch', fn);
        render(<PublicFormPage token={TOKEN} />);
        await screen.findByTestId('form-waiting-decision');
        expect(screen.queryByTestId('form-test-banner')).toBeNull();
    });
});
