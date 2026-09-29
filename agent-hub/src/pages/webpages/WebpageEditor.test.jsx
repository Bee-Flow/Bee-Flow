import { render, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * De editor geeft zijn markeringen DOOR aan Monaco.
 *
 * De vertaling markering → decoratie is puur en staat in bfDecorations.js;
 * wat hier overblijft is de bedrading, en juist die kan stil kapot: de
 * decoraties berekenen en ze vervolgens nergens naartoe sturen levert een
 * editor op die er precies zo uitziet als een pagina zonder koppelingen. Dat
 * is het verschil dat de legenda ernaast belooft te tonen, dus het moet hier
 * bewezen worden.
 *
 * Monaco zelf draait niet in jsdom (canvas, workers, metingen), dus
 * `@monaco-editor/react` is vervangen door een stub die `onMount` aanroept met
 * een nagemaakte editor. Wat dit KAN bewijzen: dat de decoraties de editor-API
 * bereiken en bij een wijziging opnieuw worden gezet. Wat dit NIET kan
 * bewijzen: dat Monaco ze ook echt tekent.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/pages/webpages/WebpageEditor.test.jsx
 */

const collection = { set: vi.fn(), clear: vi.fn() };
const editor = {
    createDecorationsCollection: vi.fn(() => collection),
    onDidChangeCursorPosition: vi.fn(),
};
const monaco = {
    languages: {
        html: { htmlDefaults: { setOptions: vi.fn() } },
        typescript: { javascriptDefaults: { setDiagnosticsOptions: vi.fn() } },
    },
};

vi.mock('@monaco-editor/react', () => ({
    // Eén keer monteren, één keer `onMount` — zoals de echte editor. Een stub
    // die bij élke render opnieuw meldt dat hij gemonteerd is, zou hier iets
    // toetsen dat nooit gebeurt.
    default: function MonacoStub({ onMount }) {
        const mounted = React.useRef(false);
        useEffect(() => {
            if (mounted.current) return;
            mounted.current = true;
            onMount?.(editor, monaco);
        }, [onMount]);
        return <div data-testid="monaco-stub" />;
    },
}));

const { default: WebpageEditor } = await import('./WebpageEditor');

const deco = (line) => ({
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: { isWholeLine: true, className: 'bf-mark bf-mark--datatable' },
});

beforeEach(() => {
    collection.set.mockReset();
    collection.clear.mockReset();
    editor.createDecorationsCollection.mockReset().mockReturnValue(collection);
});

describe('WebpageEditor', () => {
    it('BIJT — de markeringen komen echt bij Monaco terecht', async () => {
        render(<WebpageEditor value="<p>x</p>" language="html" decorations={[deco(3)]} />);

        await waitFor(() => expect(editor.createDecorationsCollection).toHaveBeenCalled());
        expect(editor.createDecorationsCollection.mock.calls[0][0]).toHaveLength(1);
        expect(editor.createDecorationsCollection.mock.calls[0][0][0].range.startLineNumber).toBe(3);
    });

    it('zet ze opnieuw als er een ander bestand of een nieuwe uitslag komt', async () => {
        const { rerender } = render(<WebpageEditor value="a" decorations={[deco(1)]} />);
        await waitFor(() => expect(editor.createDecorationsCollection).toHaveBeenCalled());

        rerender(<WebpageEditor value="b" decorations={[deco(9)]} />);
        await waitFor(() => expect(collection.set).toHaveBeenCalled());
        expect(collection.set.mock.calls.at(-1)[0][0].range.startLineNumber).toBe(9);
    });

    it('geen markeringen betekent een lege verzameling, niet de vorige die blijft staan', async () => {
        const { rerender } = render(<WebpageEditor value="a" decorations={[deco(1)]} />);
        await waitFor(() => expect(editor.createDecorationsCollection).toHaveBeenCalled());

        rerender(<WebpageEditor value="a" decorations={[]} />);
        await waitFor(() => expect(collection.set).toHaveBeenCalledWith([]));
    });

    it('een Monaco zonder decoratie-API kost hoogstens de markeringen, nooit de editor', async () => {
        editor.createDecorationsCollection = undefined;
        const { getByTestId } = render(<WebpageEditor value="a" decorations={[deco(1)]} />);
        await waitFor(() => expect(getByTestId('monaco-stub')).toBeInTheDocument());
        editor.createDecorationsCollection = vi.fn(() => collection);
    });
});
