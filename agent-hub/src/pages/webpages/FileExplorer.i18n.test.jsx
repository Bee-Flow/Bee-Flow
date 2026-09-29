import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * FileExplorer — elke zichtbare letter komt uit het woordenboek.
 *
 * De t() is hier een MARKEERDER: hij geeft `⟦sleutel⟧` terug in plaats van de
 * Engelse fallback. Daardoor faalt deze test zodra een string weer als letterlijke
 * tekst in de bron staat — de Engelse fallback zou er dan nog steeds goed uitzien
 * op het scherm, en precies dat is wat een i18n-retrofit stil kan laten mislukken.
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

import FileExplorer from './FileExplorer';

// Eén bestand in een map (voor de maprij) en één op het hoofdniveau — de
// per-bestand-acties zitten op de bestandsrij, en een map staat dicht.
const EXTRA = [
    { path: 'src/App.jsx', isText: true, size: 120 },
    { path: 'notes.txt', isText: true, size: 12 },
];

function renderExplorer(over = {}) {
    return render(
        <FileExplorer
            activeFile={null}
            onFileSelect={() => {}}
            extraFiles={EXTRA}
            onCreateFile={() => {}}
            onRename={() => {}}
            onDelete={() => {}}
            onUploadAsset={() => {}}
            {...over}
        />,
    );
}

describe('FileExplorer — i18n', () => {
    it('BIJT — de kop en de werkbalkknoppen komen uit het woordenboek', () => {
        renderExplorer();

        expect(screen.getByText('⟦webpages.explorer.title⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.explorer.new_file⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.explorer.new_folder⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.explorer.upload_asset⟧')).toBeInTheDocument();
    });

    it('BIJT — Hernoemen en Verwijderen hergebruiken de kaartsleutels, ze maken geen tweede', () => {
        renderExplorer();

        // Dezelfde twee sleutels die WebpageCard al gebruikt (W3). Een eigen
        // `webpages.explorer.delete` zou dezelfde tekst een tweede keer in het
        // woordenboek zetten.
        expect(screen.getByTitle('⟦webpages.card.rename⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.card.delete⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.explorer.copy_path⟧')).toBeInTheDocument();
    });

    it('BIJT — de padcontrole meldt in de taal van de gebruiker, met het segment als parameter', () => {
        renderExplorer();
        fireEvent.click(screen.getByTitle('⟦webpages.explorer.new_file⟧'));

        const input = screen.getByPlaceholderText('⟦webpages.explorer.ph_file⟧');
        fireEvent.change(input, { target: { value: 'a/b*c.js' } });

        // Het foute segment reist als {segment}-parameter mee — niet als stuk
        // Engels dat aan een zin is vastgeplakt.
        expect(screen.getByTitle('⟦webpages.explorer.err_unsupported_chars⟧(segment=b*c.js)')).toBeInTheDocument();
    });

    it('BIJT — een naam die al bestaat meldt dat via een sleutel', () => {
        renderExplorer();
        fireEvent.click(screen.getByTitle('⟦webpages.explorer.new_file⟧'));

        const input = screen.getByPlaceholderText('⟦webpages.explorer.ph_file⟧');
        fireEvent.change(input, { target: { value: 'src/App.jsx' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(screen.getByText('⟦webpages.explorer.exists_file⟧')).toBeInTheDocument();
    });

    it('een lege boom legt met een sleutel uit wat je hier kunt doen', () => {
        renderExplorer({ extraFiles: [] });

        expect(screen.getByText('⟦webpages.explorer.empty⟧')).toBeInTheDocument();
    });
});
