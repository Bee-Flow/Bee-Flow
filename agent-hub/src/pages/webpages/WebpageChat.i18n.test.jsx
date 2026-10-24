import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * WebpageChat — the panel already had three t() calls and sixteen literal strings beside them. The four EXAMPLE PROMPTS are the interesting ones: they are at once text for the reader AND the message that gets sent. They stood in a module constant, where t() could never reach them.
 *
 * t() is a MARKER (`⟦key⟧`); the heavy children are mocked so that this is about this panel and not about the chat input.
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

        // A caller that supplies its own placeholder still wins.
        renderChat({ placeholder: 'Van de aanroeper' });
        expect(screen.getByTestId('input-area').getAttribute('data-placeholder')).toBe('Van de aanroeper');
    });

    it('BIJT — kop, lege stand en de nieuwe-chat-knop dragen sleutels', () => {
        renderChat();

        expect(screen.getByText('⟦webpages.chat.title⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.empty_title⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.empty_body⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.chat.new⟧')).toBeInTheDocument();
        // Without a conversation there is a DIFFERENT tooltip than with one — two keys,
        // not a pasted-together sentence.
        expect(screen.getByTitle('⟦webpages.chat.new_none⟧')).toBeInTheDocument();
    });

    it('BIJT — de selectie uit de preview is vertaald, de tagnaam blijft de tagnaam', () => {
        renderChat({
            attachedSelection: { text: 'Prijzen', tagName: 'h2' },
            onSelectionClear: () => {},
        });

        expect(screen.getByText(/⟦webpages\.chat\.selection_from_preview⟧/)).toBeInTheDocument();
        // The tag comes from the page itself; it does not belong in the dictionary.
        expect(screen.getByText(/· <h2>/)).toBeInTheDocument();
        expect(screen.getByTitle('⟦webpages.chat.selection_remove⟧')).toBeInTheDocument();
    });
});
