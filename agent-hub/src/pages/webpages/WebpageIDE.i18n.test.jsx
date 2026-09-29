import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * WebpageIDE — de bovenbalk, de sleepgrepen en de binaire-bestandskaart.
 *
 * t() is een MARKEERDER (`⟦sleutel⟧`). De zware kinderen (Monaco-editor,
 * preview-iframe, chatpaneel, de bestandenstrip) zijn gemockt: dit gaat over de
 * chrome van de IDE zelf, niet over wat erin hangt.
 *
 * Wat hier vastligt: de bovenbalk HERGEBRUIKT de sleutels die W3/W4 al hebben
 * gezet (Add image, History, Code, Preview) in plaats van er een tweede paar
 * met dezelfde tekst naast te zetten.
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

vi.mock('./WebpagePreview', () => ({ default: () => <div data-testid="preview" /> }));
vi.mock('./WebpageChat', () => ({ default: () => <div data-testid="chat" /> }));
vi.mock('./WebpageEditor', () => ({ default: () => <div data-testid="editor" /> }));
vi.mock('./WebpageCodeStrip', () => ({
    default: () => <div data-testid="strip" />,
    fileDecorations: () => [],
    useBfMarks: () => ({ marks: [], state: 'idle' }),
}));

import WebpageIDE from './WebpageIDE';

const USER = { id: 'u1' };
const SELECTED = { id: 'wp1', userId: 'u1', settings: {} };

function renderIde(over = {}) {
    return render(
        <WebpageIDE
            selected={SELECTED}
            user={USER}
            html="" css="" js=""
            onHtmlChange={() => {}} onCssChange={() => {}} onJsChange={() => {}}
            chatMessages={[]}
            onUploadAsset={() => {}}
            onDownload={() => {}}
            onVersionsClick={() => {}}
            {...over}
        />,
    );
}

describe('WebpageIDE — i18n', () => {
    it('BIJT — de bovenbalk hergebruikt bestaande sleutels in plaats van dezelfde tekst een tweede keer te zetten', () => {
        renderIde();

        // Add image / History / Code bestaan sinds W3-W4; alleen ZIP was nieuw.
        expect(screen.getByText('⟦webpages.action.add_image⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.tab.history⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.tab.code⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.ide.zip⟧')).toBeInTheDocument();
    });

    it('BIJT — de standenaanduiding zegt welke stand het is, met een sleutel per stand', () => {
        const { unmount } = renderIde({ devMode: false });
        expect(screen.getByText('⟦webpages.preview.title⟧')).toBeInTheDocument();
        unmount();

        renderIde({ devMode: true });
        expect(screen.getByText('⟦webpages.ide.view_developer⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.ide.hide_code⟧')).toBeInTheDocument();
    });

    it('BIJT — de sleepgrepen zijn voor een schermlezer benoemd, en vertaald', () => {
        renderIde({ devMode: true });

        const separators = screen.getAllByRole('separator').map(el => el.getAttribute('aria-label'));
        expect(separators).toContain('⟦webpages.ide.resize_chat⟧');
    });

    it('BIJT — de binaire-bestandskaart legt in de taal van de gebruiker uit waarom er niets te bewerken valt', () => {
        // Via de echte weg: een geopend niet-tekstbestand in de ontwikkelaarsstand.
        renderIde({
            devMode: true,
            extraFiles: [{ path: 'assets/logo.png', mimeType: 'image/png', size: 1024 }],
            extraContents: { 'assets/logo.png': { isText: false, mimeType: 'image/png', dataUrl: '' } },
            focusFile: { key: 'extra:assets/logo.png', at: 1 },
        });

        expect(screen.getByText('⟦webpages.ide.binary_not_editable⟧')).toBeInTheDocument();
        // Het pad en het mimetype zijn machinetekst en blijven staan.
        expect(screen.getAllByText('assets/logo.png').length).toBeGreaterThan(0);
        expect(screen.getByText(/image\/png/)).toBeInTheDocument();
    });
});
