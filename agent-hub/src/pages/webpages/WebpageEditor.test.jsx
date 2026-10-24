import { render, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The editor passes its markers THROUGH to Monaco.
 *
 * The translation marker → decoration is pure and lives in bfDecorations.js; what remains here is the wiring, and precisely that can break silently: computing the decorations and then sending them nowhere yields an editor that looks exactly like a page without bindings. That is the difference that the legend beside it promises to show, so it must be proven here.
 *
 * Monaco itself does not run in jsdom (canvas, workers, measurements), so `@monaco-editor/react` is replaced by a stub that calls `onMount` with a mimicked editor. What this CAN prove: that the decorations reach the editor API and are set again on a change. What this can NOT prove: that Monaco also actually draws them.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/pages/webpages/WebpageEditor.test.jsx
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
    // Mount once, one `onMount` — like the real editor. A stub that reports at every
    // render that it has been mounted would here test something that never happens.
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
