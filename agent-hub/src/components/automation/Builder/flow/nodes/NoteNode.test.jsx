import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import NoteNode from './NoteNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * BFSF-479 — the note's display-side formatting: **bold**, *italic*, `- `
 * bullet lines and `1. ` numbered lines (noteRichText.jsx). Editing stays a
 * plain textarea; the styled render is what a committed note shows.
 */

function renderNote({ text = '', editable = true, selected = false, rt = {} } = {}) {
    const step = { id: 'note_1', type: 'note', text };
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{ onPatchStep: editable ? vi.fn() : null, ...rt }}>
                <NoteNode id="note_1" selected={selected} data={{ step, issues: { errors: [], warnings: [] } }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

describe('NoteNode — rich text display (BFSF-479)', () => {
    beforeEach(cleanup);

    it('renders **bold** and *italic* as real elements, with the markers gone', () => {
        renderNote({ text: 'a **brave** and *calm* note' });
        expect(screen.getByText('brave').tagName).toBe('STRONG');
        expect(screen.getByText('calm').tagName).toBe('EM');
        expect(screen.queryByText(/\*\*/)).toBeNull();
    });

    it('folds consecutive "- " lines into a bullet list', () => {
        const { container } = renderNote({ text: '- one\n- two\nplain line' });
        const ul = container.querySelector('ul');
        expect(ul).toBeTruthy();
        expect(ul.querySelectorAll('li').length).toBe(2);
        expect(screen.getByText('plain line')).toBeTruthy();
    });

    it('folds "1. " lines into a numbered list', () => {
        const { container } = renderNote({ text: '1. first\n2. second' });
        expect(container.querySelectorAll('ol li').length).toBe(2);
    });

    it('a lone asterisk stays literal text', () => {
        renderNote({ text: '2 * 3 = 6' });
        expect(screen.getByText('2 * 3 = 6')).toBeTruthy();
    });

    it('shows the markup legend while editing, and only then', () => {
        renderNote({ text: 'hello' });
        expect(screen.queryByText(/\*\*bold\*\*/)).toBeNull();
        fireEvent.click(screen.getByText('hello'));
        expect(screen.getByText(/\*\*bold\*\*/)).toBeTruthy();
    });
});
