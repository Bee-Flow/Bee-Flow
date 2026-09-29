import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageSources (het Kennis-paneel) — elke zichtbare letter uit het woordenboek.
 *
 * t() is een MARKEERDER: `⟦sleutel⟧` in plaats van de Engelse fallback. Een
 * string die weer letterlijk in de bron staat leest op het scherm nog steeds
 * goed, dus alleen zo is de retrofit te bewijzen.
 */

const t = (key, fallback, params) => {
    const p = typeof fallback === 'string' ? params : fallback;
    const tail = p && typeof p === 'object'
        ? `(${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')})`
        : '';
    return `⟦${key}⟧${tail}`;
};

vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }) => children,
    ensureI18nDefaults: () => Promise.resolve(),
}));

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

import WebpageSources from './WebpageSources';

beforeEach(() => { authFetch.mockReset(); });

function renderPanel(sources) {
    return render(<WebpageSources webpageId="wp1" sources={sources} onSourcesChange={() => {}} />);
}

describe('WebpageSources — i18n', () => {
    it('BIJT — het soort-badge komt uit labelKey, niet uit de Engelse waarde ernaast', () => {
        renderPanel([
            { id: 's1', type: 'pdf', name: 'Handboek.pdf', status: 'ready', wordCount: 4200 },
        ]);

        // SOURCE_META draagt de sleutel; `label:` is er alleen nog als fallback.
        expect(screen.getByText('⟦webpages.knowledge.type_pdf⟧')).toBeInTheDocument();
    });

    it('BIJT — het woordenaantal kiest de MEERVOUDSSLEUTEL, niet een aangeplakte s', () => {
        renderPanel([
            { id: 's1', type: 'text', name: 'Eén woord', status: 'ready', wordCount: 1 },
            { id: 's2', type: 'text', name: 'Meer woorden', status: 'ready', wordCount: 4200 },
        ]);

        expect(screen.getByText('⟦webpages.knowledge.words⟧(count=1)')).toBeInTheDocument();
        // Het getal blijft door toLocaleString heen gaan: de opmaak van het
        // aantal is van de browser, de vorm van de zin van de sleutel.
        // De scheidingstekens staan als ESCAPE in de karakterklasse, niet als
        // letterlijk teken: een smalle spatie (U+202F) en een harde spatie
        // (U+00A0) zijn in de bron niet van een gewone spatie te onderscheiden,
        // en wie de regex ooit herschrijft haalt ze er stilzwijgend uit —
        // waarna deze assertie faalt op elke locale die ze als
        // duizendtalscheider gebruikt.
        expect(screen.getByText(/⟦webpages\.knowledge\.words_plural⟧\(count=4[,.\u202f\u00a0]?200\)/)).toBeInTheDocument();
    });

    it('BIJT — verwerken, fout en de drie rijknoppen dragen sleutels', () => {
        renderPanel([
            { id: 's1', type: 'url', name: 'example.com', status: 'processing' },
            { id: 's2', type: 'csv', name: 'rijen.csv', status: 'error', error: 'boom', storageKey: 'k' },
        ]);

        expect(screen.getByText('⟦webpages.knowledge.processing⟧')).toBeInTheDocument();
        // Deze drie wijzen bewust naar common.*: hun tekst bestond daar al, en een
        // tweede sleutel met dezelfde tekst is precies wat I18N-CONVENTIES 1.3 verbiedt.
        // Wat deze test bewaakt blijft hetzelfde — de tekst gaat door een SLEUTEL heen,
        // niet als letterlijke string.
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
