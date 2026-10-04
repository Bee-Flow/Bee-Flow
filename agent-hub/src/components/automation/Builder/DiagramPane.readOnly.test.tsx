import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import DiagramPaneJs from './DiagramPane';

// DiagramPane is a .jsx forwardRef; its props are only guessed from defaults.
const DiagramPane = DiagramPaneJs as unknown as React.ComponentType<Record<string, unknown>>;

/**
 * An automation managed by a Solution stage: BuildTab hands DiagramPane
 * `editable={false}` and `structuralEditsBlocked`, and withholds the palette and
 * assistant handlers. Whatever the user does on the canvas, the definition does
 * not change and there is no way into the AI builder.
 */
const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: 0 } },
    steps: [
        { id: 'a', type: 'set', label: 'Shape', position: { x: 320, y: 0 } },
        { id: 'b', type: 'set', label: 'Tidy', position: { x: 640, y: 0 } },
    ],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
};

function renderReadOnly(props: Record<string, unknown> = {}) {
    const onDefinitionChange = vi.fn();
    const view = render(
        <div style={{ width: 1200, height: 800 }}>
            <DiagramPane
                definition={DEF}
                editable={false}
                structuralEditsBlocked
                onDefinitionChange={onDefinitionChange}
                onAskAssistant={null}
                onOpenAssistant={null}
                {...props}
            />
        </div>,
    );
    return { ...view, onDefinitionChange };
}

describe('DiagramPane — read-only (a managed automation)', () => {
    beforeEach(cleanup);

    it('still draws every step', () => {
        const { container } = renderReadOnly();
        expect(container.querySelector('.react-flow__node[data-id="a"]')!).toBeTruthy();
        expect(container.querySelector('.react-flow__node[data-id="b"]')).toBeTruthy();
    });

    it('does not delete the selected step on Delete', () => {
        const { container, onDefinitionChange } = renderReadOnly();
        fireEvent.click(container.querySelector('.react-flow__node[data-id="a"]')!);
        fireEvent.keyDown(document, { key: 'Delete' });
        expect(onDefinitionChange).not.toHaveBeenCalled();
    });

    it('offers no assistant entry in the node menu', () => {
        const { container } = renderReadOnly();
        fireEvent.contextMenu(container.querySelector('.react-flow__node[data-id="a"]')!, { clientX: 200, clientY: 200 });
        expect(screen.queryByRole('menuitem', { name: /ask the assistant/i })).toBeNull();
    });

    it('the empty canvas has no assistant button when the host withholds it', () => {
        render(<DiagramPane definition={null} editable={false} structuralEditsBlocked onOpenAssistant={null} onAddTrigger={null} />);
        expect(screen.queryByRole('button', { name: 'Assistant' })).toBeNull();
    });
});
