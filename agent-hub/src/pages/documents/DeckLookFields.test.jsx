import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * One form, two owners. In HOUSE mode every control has a value (the
 * organisation's deck style); in DOCUMENT mode every control offers "House
 * style" — an unset key — and the document may bring its own logo or
 * template deck. What is pinned: the values the form hands back, because a
 * wrong one here is a wrong colour on every slide.
 */

vi.mock('./documentsApi', () => ({
    fileToDataUrl: vi.fn(async () => 'data:image/png;base64,AAA='),
    uploadDeckTemplate: vi.fn(async () => ({ name: 'Conf.pptx', cover: { image: 'data:image/jpeg;base64,BBB=' }, content: { image: 'data:image/jpeg;base64,CCC=' } })),
}));

const DeckLookFields = (await import('./DeckLookFields')).default;
const t = (k, fb) => fb || k;
const HOUSE = { accent: '#123a5e', font: 'sans', footerText: 'Van Dijk', deck: { preset: 'band', accent: '', footerText: '' } };

afterEach(cleanup);

describe('DeckLookFields — document mode', () => {
    it('offers "House style" as the first preset and on every switch; choosing it removes the key', () => {
        const setDeck = vi.fn();
        render(<DeckLookFields mode="document" testPrefix="document-deck" deck={{ preset: 'dark', slideNumbers: false }} setDeck={setDeck} style={HOUSE} t={t} />);
        expect(screen.getByTestId('document-deck-preset-inherit').getAttribute('aria-checked')).toBe('false');
        expect(screen.getByTestId('document-deck-preset-dark').getAttribute('aria-checked')).toBe('true');
        fireEvent.click(screen.getByTestId('document-deck-preset-inherit'));
        expect(setDeck).toHaveBeenCalledWith('preset', '');
        const numbers = screen.getByTestId('document-deck-slideNumbers');
        expect(numbers.value).toBe('off');
        fireEvent.change(numbers, { target: { value: '' } });
        expect(setDeck).toHaveBeenCalledWith('slideNumbers', undefined);
        fireEvent.change(numbers, { target: { value: 'on' } });
        expect(setDeck).toHaveBeenCalledWith('slideNumbers', true);
        // Selects carry the inherit option too.
        expect(screen.getByTestId('document-deck-coverStyle').querySelector('option[value=""]').textContent).toBe('House style');
    });

    it('the logo and the template deck are three-way choices: house style, none, own', async () => {
        const setDeck = vi.fn();
        const { rerender } = render(<DeckLookFields mode="document" testPrefix="document-deck" deck={{}} setDeck={setDeck} style={HOUSE} t={t} />);
        expect(screen.getByTestId('document-deck-logo-house').getAttribute('aria-checked')).toBe('true');
        fireEvent.click(screen.getByTestId('document-deck-logo-none'));
        expect(setDeck).toHaveBeenCalledWith('logo', 'none');
        fireEvent.change(screen.getByTestId('document-deck-logo-file'), { target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] } });
        await vi.waitFor(() => expect(setDeck).toHaveBeenCalledWith('logo', 'data:image/png;base64,AAA='));
        rerender(<DeckLookFields mode="document" testPrefix="document-deck" deck={{ logo: 'data:image/png;base64,AAA=', template: 'none' }} setDeck={setDeck} style={HOUSE} t={t} />);
        expect(screen.getByTestId('document-deck-logo-own').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('document-deck-logo-preview')).toBeTruthy();
        expect(screen.getByTestId('document-deck-template-none').getAttribute('aria-checked')).toBe('true');
        fireEvent.click(screen.getByTestId('document-deck-template-house'));
        expect(setDeck).toHaveBeenCalledWith('template', undefined);
        fireEvent.change(screen.getByTestId('document-deck-template-file'), { target: { files: [new File(['x'], 'Conf.pptx')] } });
        await vi.waitFor(() => expect(setDeck).toHaveBeenCalledWith('template', expect.objectContaining({ name: 'Conf.pptx' })));
        // No house-style suggestions in document mode: the letterhead is not this document's to change.
        expect(screen.queryByTestId('house-style-template-suggestions')).toBeNull();
    });

    it('an own colour is a tick; unticking hands the colour back to the house style', () => {
        const setDeck = vi.fn();
        render(<DeckLookFields mode="document" testPrefix="document-deck" deck={{ accent: '#AA0000' }} setDeck={setDeck} style={HOUSE} t={t} />);
        const tick = screen.getByTestId('document-deck-accent-own');
        expect(tick.checked).toBe(true);
        fireEvent.click(tick);
        expect(setDeck).toHaveBeenCalledWith('accent', '');
    });
});

describe('DeckLookFields — house mode', () => {
    it('keeps the house-style ids and checkboxes the panel test relies on', () => {
        const setDeck = vi.fn();
        render(<DeckLookFields mode="house" deck={HOUSE.deck} setDeck={setDeck} style={HOUSE} set={vi.fn()} t={t} />);
        expect(screen.queryByTestId('house-style-deck-preset-inherit')).toBeNull();
        expect(screen.getByTestId('house-style-deck-preset-band').getAttribute('aria-checked')).toBe('true');
        const numbers = screen.getByTestId('house-style-deck-numbers');
        expect(numbers.type).toBe('checkbox');
        fireEvent.click(numbers);
        expect(setDeck).toHaveBeenCalledWith('slideNumbers', false);
        expect(screen.queryByTestId('house-style-deck-logo-house')).toBeNull();
        expect(screen.getByTestId('house-style-deck-template-file')).toBeTruthy();
    });
});
