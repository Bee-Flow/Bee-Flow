import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranslateFn } from '../../hooks/useTranslation';

/**
 * WebpageSources (the Knowledge panel) — every visible letter from the dictionary.
 *
 * t() is a MARKER: `⟦key⟧` instead of the English fallback. A string that again stands literally in the source still reads well on screen, so only this way can the retrofit be proven.
 */

const t: TranslateFn = (key, fallback, params) => {
    const p = typeof fallback === 'string' ? params : fallback;
    const tail = p && typeof p === 'object'
        ? `(${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')})`
        : '';
    return `⟦${key}⟧${tail}`;
};

vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }: { children: ReactNode }) => children,
    ensureI18nDefaults: () => Promise.resolve(),
}));

const authFetch = vi.fn<(url: string, init?: { body?: string }) => Promise<unknown>>();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args: Parameters<typeof authFetch>) => authFetch(...args),
}));

import WebpageSources, { type WebpageSource } from './WebpageSources';

beforeEach(() => { authFetch.mockReset(); });

function renderPanel(sources: WebpageSource[]) {
    return render(<WebpageSources webpageId="wp1" sources={sources} onSourcesChange={() => {}} />);
}

describe('WebpageSources — i18n', () => {
    it('BIJT — het soort-badge komt uit labelKey, niet uit de Engelse waarde ernaast', () => {
        renderPanel([
            { id: 's1', type: 'pdf', name: 'Handboek.pdf', status: 'ready', wordCount: 4200 },
        ]);

        // SOURCE_META carries the key; `label:` remains only as fallback.
        expect(screen.getByText('⟦webpages.knowledge.type_pdf⟧')).toBeInTheDocument();
    });

    it('BIJT — het woordenaantal kiest de MEERVOUDSSLEUTEL, niet een aangeplakte s', () => {
        renderPanel([
            { id: 's1', type: 'text', name: 'Eén woord', status: 'ready', wordCount: 1 },
            { id: 's2', type: 'text', name: 'Meer woorden', status: 'ready', wordCount: 4200 },
        ]);

        expect(screen.getByText('⟦webpages.knowledge.words⟧(count=1)')).toBeInTheDocument();
        // The number still passes through toLocaleString: the formatting of the count
        // belongs to the browser, the shape of the sentence to the key. The separators
        // stand as an ESCAPE in the character class, not as a literal character: a
        // narrow no-break space (U+202F) and a no-break space (U+00A0) cannot be told
        // apart from an ordinary space in the source, and whoever ever rewrites the
        // regex silently drops them — after which this assertion fails on every locale
        // that uses them as a thousands separator.
        expect(screen.getByText(/⟦webpages\.knowledge\.words_plural⟧\(count=4[,.\u202f\u00a0]?200\)/)).toBeInTheDocument();
    });

    it('BIJT — verwerken, fout en de drie rijknoppen dragen sleutels', () => {
        renderPanel([
            { id: 's1', type: 'url', name: 'example.com', status: 'processing' },
            { id: 's2', type: 'csv', name: 'rijen.csv', status: 'error', error: 'boom', storageKey: 'k' },
        ]);

        expect(screen.getByText('⟦webpages.knowledge.processing⟧')).toBeInTheDocument();
        // These three deliberately point to common.*: their text already existed there,
        // and a second key with the same text is precisely what I18N-CONVENTIES 1.3
        // forbids. What this test guards remains the same — the text goes through a
        // KEY, not as a literal string.
        expect(screen.getByText('⟦common.error⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.knowledge.retry⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦common.cancel⟧')).toBeInTheDocument();
        // Verwijderen hergebruikt de bestaande kaartsleutel.
        expect(screen.getAllByTitle('⟦webpages.card.delete⟧').length).toBe(2);
    });

    it('BIJT — de lege stand en de drie toevoegknoppen komen uit het woordenboek', () => {
        renderPanel([]);

        expect(screen.getByText('⟦webpages.knowledge.empty_title⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.knowledge.empty_body⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.knowledge.add_file⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.knowledge.add_url⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.knowledge.add_text⟧')).toBeInTheDocument();
    });
});
