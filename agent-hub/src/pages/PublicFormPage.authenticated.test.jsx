import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';

/**
 * Who the visitor is, and what that changes on the closing page.
 *
 * `authenticated` is the ONE thing PublicFormPage branches on. It gates the
 * single export that needs somewhere to save to; everything else on the page
 * is identical for a stranger and a colleague.
 *
 * Characterisation only (FRM-0). wart: today the flag is always true —
 * /f/<token> redirects into /app/forms/:token (App.jsx) because
 * PUBLIC_FORMS_ENABLED is a hard-coded false on the server — so the false
 * branch is the degradation path for a switch nobody can flip. FRM-11 decides
 * whether that switch becomes real.
 */

/*
 * Nothing here may go through authFetch: it reloads the whole document on any
 * 401, which is a redirect loop for a visitor with no session. Two details
 * make the spy below actually bite:
 *
 *   • It mocks `../utils/helpers`, which is where authFetch really lives.
 *     `../utils/authFetch` does not exist, so mocking THAT path installs a
 *     spy nothing can ever reach — and "was never called" is then true no
 *     matter what the page does.
 *   • It forwards to the stubbed global fetch, so a page that DID route
 *     through authFetch still works end to end and the not-called assertion
 *     is the only thing that fails — the failure names the cause instead of
 *     showing up as a POST that silently never landed.
 *
 * Partial mock over importOriginal, so the rest of helpers keeps working.
 */
const { authFetch } = vi.hoisted(() => ({
    authFetch: vi.fn((...args) => globalThis.fetch(...args)),
}));
vi.mock('../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    authFetch,
}));

const { default: PublicFormPage } = await import('./PublicFormPage');

const TOKEN = 'a'.repeat(48);
const SESSION = 'c'.repeat(48);
// The export bar only appears for a closing page with a real result on it
// (over 240 characters); a one-line "Thanks!" has nothing worth keeping.
const RESULT = '## Waterstralen\n\n' + 'Een alinea over de gevonden offertes. '.repeat(12);

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

const journey = (extra = {}) => ({
    [`GET /${TOKEN}`]: async () => ({ body: { form: FORM, csrf: 'csrf-1', issuedAt: Date.now() - 10_000 } }),
    [`POST /${TOKEN}`]: async () => ({ status: 202, body: { accepted: true, sessionId: SESSION } }),
    [`GET /${TOKEN}/s/${SESSION}`]: async () => ({
        body: { state: 'done', ending: { title: 'All done', description: RESULT, theme: FORM.theme } },
    }),
    ...extra,
});

async function finishTheForm() {
    await screen.findByText('Contact us');
    fireEvent.change(screen.getByLabelText(/Your email/), { target: { value: 'a@b.nl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send it' }));
    await screen.findByText('All done', {}, { timeout: 4000 });
}

describe('PublicFormPage — what a signed-in visitor gets on the closing page', () => {
    beforeEach(() => {
        cleanup();
        authFetch.mockClear();
        document.documentElement.removeAttribute('data-theme');
        window.history.replaceState(null, '', `/f/${TOKEN}`);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('offers Save to Notebook only when it knows there is somewhere to save to', async () => {
        vi.stubGlobal('fetch', mockFetch(journey()));
        const { unmount } = render(<PublicFormPage token={TOKEN} authenticated={false} />);
        await finishTheForm();
        expect(screen.queryByTestId('form-export-notebook')).toBeNull();

        unmount();
        cleanup();
        window.history.replaceState(null, '', `/f/${TOKEN}`);
        render(<PublicFormPage token={TOKEN} authenticated />);
        await finishTheForm();
        expect(screen.getByTestId('form-export-notebook')).toBeTruthy();
    });

    it('still hands an anonymous visitor the result as a file or a copy', async () => {
        vi.stubGlobal('fetch', mockFetch(journey()));
        render(<PublicFormPage token={TOKEN} authenticated={false} />);
        await finishTheForm();
        // Both are pure client-side operations on text already on screen.
        expect(screen.getByTestId('form-export-download')).toBeTruthy();
        expect(screen.getByTestId('form-export-copy')).toBeTruthy();
    });

    it('saves the closing page\'s own text against the journey that produced it', async () => {
        let posted = null;
        vi.stubGlobal('fetch', mockFetch(journey({
            [`POST /${TOKEN}/s/${SESSION}/notebook`]: async (init) => {
                posted = JSON.parse(init.body);
                return { body: { notebookId: 'nb_1' } };
            },
        })));
        render(<PublicFormPage token={TOKEN} authenticated />);
        await finishTheForm();

        // The session is already gone from the URL by now — the save still
        // has to reach the right journey.
        expect(new URLSearchParams(window.location.search).get('s')).toBeNull();
        fireEvent.click(screen.getByTestId('form-export-notebook'));

        await waitFor(() => expect(posted).not.toBeNull());
        expect(posted).toEqual({ text: RESULT, title: 'All done' });
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('says why a save failed and lets the visitor try again', async () => {
        vi.stubGlobal('fetch', mockFetch(journey({
            [`POST /${TOKEN}/s/${SESSION}/notebook`]: async () => ({ ok: false, status: 500, body: { error: 'Notebooks are unavailable.' } }),
        })));
        render(<PublicFormPage token={TOKEN} authenticated />);
        await finishTheForm();

        fireEvent.click(screen.getByTestId('form-export-notebook'));
        expect(await screen.findByText('Notebooks are unavailable.')).toBeTruthy();
        expect(screen.getByTestId('form-export-notebook').getAttribute('aria-disabled')).toBe('false');
    });
});
