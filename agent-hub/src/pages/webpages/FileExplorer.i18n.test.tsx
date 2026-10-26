import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

/**
 * FileExplorer — every visible letter comes from the dictionary.
 *
 * The t() here is a MARKER: it returns `⟦key⟧` instead of the English fallback. This test therefore fails as soon as a string is again present as literal text in the source — the English fallback would still look right on screen, and precisely that is what an i18n retrofit can silently let fail.
 */

const t = (key: string, fallback: string, params: TranslateParams) => {
    const p = typeof fallback === 'string' ? params : fallback;
    const tail = p && typeof p === 'object'
        ? `(${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')})`
        : '';
    return `⟦${key}⟧${tail}`;
};

vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }: { children?: ReactNode }) => children,
    ensureI18nDefaults: () => Promise.resolve(),
}));

import FileExplorer from './FileExplorer';
import { type ReactNode } from 'react';
import { type TranslateParams } from '@/hooks/useTranslation';

// One file in a folder (for the folder row) and one at the top level — the
// per-file actions sit on the file row, and a folder stays closed.
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

        // The same two keys that WebpageCard already uses (W3). An own
        // `webpages.explorer.delete` would put the same text into the dictionary a
        // second time.
        expect(screen.getByTitle('⟦webpages.card.rename⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.card.delete⟧')).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.explorer.copy_path⟧')).toBeInTheDocument();
    });

    it('BIJT — de padcontrole meldt in de taal van de gebruiker, met het segment als parameter', async () => {
        const user = userEvent.setup();
        renderExplorer();
        await user.click(screen.getByTitle('⟦webpages.explorer.new_file⟧'));

        const input = screen.getByPlaceholderText('⟦webpages.explorer.ph_file⟧');
        fireEvent.change(input, { target: { value: 'a/b*c.js' } });

        // The wrong segment travels as a {segment} parameter — not as a piece of
        // English pasted onto a sentence.
        expect(screen.getByTitle('⟦webpages.explorer.err_unsupported_chars⟧(segment=b*c.js)')).toBeInTheDocument();
    });

    it('BIJT — een naam die al bestaat meldt dat via een sleutel', async () => {
        const user = userEvent.setup();
        renderExplorer();
        await user.click(screen.getByTitle('⟦webpages.explorer.new_file⟧'));

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
