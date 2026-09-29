import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * WebpageChat — het paneel had al drie t()-aanroepen en zestien letterlijke
 * strings ernaast. De vier VOORBEELDPROMPTS zijn de interessante: ze zijn
 * tegelijk tekst voor de lezer én het bericht dat verstuurd wordt. Ze stonden
 * in een module-constante, waar t() nooit bij kan.
 *
 * t() is een MARKEERDER (`⟦sleutel⟧`); de zware kinderen zijn gemockt zodat dit
 * over dit paneel gaat en niet over de chat-invoer.
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

vi.mock('../../components/chat/InputArea', () => ({
    default: ({ placeholder }) => <div data-testid="input-area" data-placeholder={placeholder} />,
}));
vi.mock('../../components/chat/MessageItem', () => ({ default: () => <div data-testid="message" /> }));
vi.mock('../../components/shared/SegmentedControl', () => ({
    default: ({ options }) => <div data-testid="mode">{options.map(o => o.label).join('|')}</div>,
}));

import WebpageChat from './WebpageChat';

function renderChat(over = {}) {
    return render(
        <WebpageChat
            messages={[]}
            isLoading={false}
            onSend={() => {}}
            onStop={() => {}}
            onNewChat={() => {}}
            {...over}
        />,
    );
}

describe('WebpageChat — i18n', () => {
    it('BIJT — de vier voorbeeldprompts komen uit het woordenboek, niet uit een module-constante', () => {
        renderChat();

        expect(screen.getByText('⟦webpages.chat.quick_bakery⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.quick_portfolio⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.quick_signup⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.quick_dashboard⟧')).toBeInTheDocument();
    });

    it('BIJT — een voorbeeld verstuurt de VERTAALDE tekst, want dat is wat de lezer aanklikte', () => {
        const onSend = vi.fn();
        renderChat({ onSend });

        fireEvent.click(screen.getByText('⟦webpages.chat.quick_bakery⟧'));

        expect(onSend).toHaveBeenCalledWith('⟦webpages.chat.quick_bakery⟧', []);
    });

    it('BIJT — de standaard-placeholder komt uit het woordenboek en blijft overschrijfbaar', () => {
        const { unmount } = renderChat();
        expect(screen.getByTestId('input-area').getAttribute('data-placeholder'))
            .toBe('⟦webpages.chat.placeholder⟧');
        unmount();

        // Een aanroeper die zelf een placeholder meegeeft, wint nog steeds.
        renderChat({ placeholder: 'Van de aanroeper' });
        expect(screen.getByTestId('input-area').getAttribute('data-placeholder')).toBe('Van de aanroeper');
    });

    it('BIJT — kop, lege stand en de nieuwe-chat-knop dragen sleutels', () => {
        renderChat();

        expect(screen.getByText('⟦webpages.chat.title⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.empty_title⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.empty_body⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.new⟧')).toBeInTheDocument();
        // Zonder gesprek staat er een ANDERE tooltip dan met — twee sleutels,
        // geen samengeplakte zin.
        expect(screen.getByTitle('⟦webpages.chat.new_none⟧')).toBeInTheDocument();
    });

    it('BIJT — de selectie uit de preview is vertaald, de tagnaam blijft de tagnaam', () => {
        renderChat({
            attachedSelection: { text: 'Prijzen', tagName: 'h2' },
            onSelectionClear: () => {},
        });

        expect(screen.getByText(/⟦webpages\.chat\.selection_from_preview⟧/)).toBeInTheDocument();
        // De tag komt uit de pagina zelf; die hoort niet in het woordenboek.
        expect(screen.getByText(/· <h2>/)).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.chat.selection_remove⟧')).toBeInTheDocument();
    });
});
