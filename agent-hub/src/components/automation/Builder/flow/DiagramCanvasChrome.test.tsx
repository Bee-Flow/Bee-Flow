import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CanvasContextMenu } from './DiagramCanvasChrome';
import type { DiagramDefinition } from './diagramPaneTypes';

// The flat graph of a canvas with one flowlet drawn open: the flowlet's
// layer_input sits among the steps under its prefixed id.
const flat = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'cl1', type: 'call_layer', layerKey: 'enrich' },
        { id: 'cl1/trg', type: 'trigger', kind: 'layer_input' },
        { id: 'cl1/s1', type: 'ai_step' },
    ],
    edges: [{ from: 'trg', to: 'cl1' }, { from: 'cl1/trg', to: 'cl1/s1' }],
} as unknown as DiagramDefinition;

function open(stepId: string) {
    render(
        <CanvasContextMenu
            menu={{ stepId, x: 10, y: 10 }}
            definition={flat}
            inlineExpandedIds={new Set(['cl1'])}
            inlineTriggerIds={new Set(['cl1/trg'])}
            onDuplicateNode={vi.fn()}
            onDetachNode={vi.fn()}
            onDeleteNode={vi.fn()}
            runInFlight={false}
            onClose={vi.fn()}
        />,
    );
}

describe('CanvasContextMenu', () => {
    it('offers no duplicate, disconnect or delete on an expanded flowlet\'s trigger', () => {
        open('cl1/trg');
        expect(screen.getByRole('menuitem', { name: /duplicate/i })).toBeDisabled();
        expect(screen.getByRole('menuitem', { name: /disconnect/i })).toBeDisabled();
        expect(screen.getByRole('menuitem', { name: /delete/i })).toBeDisabled();
    });

    it('keeps them for an ordinary step inside the flowlet', () => {
        open('cl1/s1');
        expect(screen.getByRole('menuitem', { name: /duplicate/i })).toBeEnabled();
        expect(screen.getByRole('menuitem', { name: /disconnect/i })).toBeEnabled();
        expect(screen.getByRole('menuitem', { name: /delete/i })).toBeEnabled();
    });
});
