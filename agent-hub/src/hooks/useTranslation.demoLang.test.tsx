/**
 * A framed feature demo (/__demo__/<feature>?lang=nl) takes its language from
 * the marketing page around it. It must never write the visitor's stored
 * choice, and must not ask the server for an org default locale.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TranslationProvider, useTranslation } from './useTranslation';

function Probe() {
    const { locale, setLocale } = useTranslation();
    return (
        <>
            <span data-testid="locale">{locale}</span>
            <button type="button" onClick={() => setLocale('en')}>switch</button>
        </>
    );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
});

describe('TranslationProvider on a demo path', () => {
    it('uses ?lang=, leaves beeflow_locale alone and skips the org-locale probe', async () => {
        localStorage.setItem('beeflow_locale', 'en');
        window.history.replaceState({}, '', '/__demo__/x?lang=nl');
        render(<TranslationProvider><Probe /></TranslationProvider>);
        expect(screen.getByTestId('locale').textContent).toBe('nl');

        await act(async () => { screen.getByText('switch').click(); });
        expect(screen.getByTestId('locale').textContent).toBe('en');
        expect(localStorage.getItem('beeflow_locale')).toBe('en');

        localStorage.setItem('beeflow_locale', 'fr');
        await act(async () => { screen.getByText('switch').click(); });
        expect(localStorage.getItem('beeflow_locale')).toBe('fr');

        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes('/api/languages/user/locales'))).toBe(false);
    });
});
