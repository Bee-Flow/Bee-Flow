/**
 * "Reset to the default theme" — ThemeContext's clearUserOverride().
 *
 * It sent `PUT /api/branding/user` with the literal body `null`. The server's
 * JSON parser is strict (an object or an array, nothing else), so that request
 * died as a 400 "Invalid JSON body" before the branding route ever ran, and the
 * member's own theme stayed. The server now has `DELETE /api/branding/user`,
 * which needs no body; this pins that the client uses it — and that a refusal
 * still reaches the caller.
 *
 * Run: cd agent-hub && npx vitest run src/components/appearance/ThemeContext.userOverride.test.tsx
 */
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';

type Theme = ReturnType<typeof useTheme>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

function renderWithTheme(): { current: () => Theme } {
    let latest: Theme | null = null;
    function Probe() {
        latest = useTheme();
        return null;
    }
    render(<ThemeProvider><Probe /></ThemeProvider>);
    return { current: () => latest as unknown as Theme };
}

type FetchSpy = MockInstance<typeof fetch>;

const brandingCalls = (spy: FetchSpy, path: string) => spy.mock.calls
    .filter(([url]) => String(url).endsWith(path));

describe('ThemeContext clearUserOverride', () => {
    let fetchSpy: FetchSpy;
    let userAnswer: () => Response;

    beforeEach(() => {
        window.history.replaceState({}, '', '/app/settings');
        userAnswer = () => json({ override: null, effective: { preset: 'light' } });
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
            String(url).endsWith('/api/branding/user') ? userAnswer() : json({ preset: 'light' })
        ));
    });
    afterEach(() => { fetchSpy.mockRestore(); });

    it('asks the server with DELETE and no body — never a PUT of `null`', async () => {
        const theme = renderWithTheme();
        await waitFor(() => expect(brandingCalls(fetchSpy, '/api/branding/effective').length).toBeGreaterThan(0));

        await theme.current().clearUserOverride();

        const calls = brandingCalls(fetchSpy, '/api/branding/user');
        expect(calls).toHaveLength(1);
        const init = calls[0][1] ?? {};
        expect(init.method).toBe('DELETE');
        expect(init.body).toBeUndefined();
    });

    it('reloads the effective theme afterwards, so the page shows the organisation look', async () => {
        const theme = renderWithTheme();
        await waitFor(() => expect(brandingCalls(fetchSpy, '/api/branding/effective').length).toBeGreaterThan(0));
        const before = brandingCalls(fetchSpy, '/api/branding/effective').length;

        await theme.current().clearUserOverride();

        expect(brandingCalls(fetchSpy, '/api/branding/effective').length).toBe(before + 1);
    });

    it('a refusal reaches the caller in the server\'s words', async () => {
        userAnswer = () => json({ error: 'User theme override is disabled by the administrator' }, 403);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const theme = renderWithTheme();
        await waitFor(() => expect(brandingCalls(fetchSpy, '/api/branding/effective').length).toBeGreaterThan(0));

        await expect(theme.current().clearUserOverride()).rejects.toThrow('User theme override is disabled by the administrator');
        errorSpy.mockRestore();
    });
});
