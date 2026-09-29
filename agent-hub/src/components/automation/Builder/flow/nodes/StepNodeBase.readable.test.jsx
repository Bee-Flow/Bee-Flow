import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import StepNodeBase from './StepNodeBase';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * Titles and descriptions stay readable at every zoom level (user feedback
 * 2026-09-03). Up close the name may wrap to two lines and the badge keeps out
 * of its row; zoomed out the card shows the NAME large, not the type word.
 */
const lod = vi.hoisted(() => ({ value: 'near' }));
vi.mock('../useZoomLod', async (importOriginal) => {
    const mod = await importOriginal();
    const hook = () => lod.value;
    return { ...mod, default: hook, useZoomLod: hook };
});

function renderCard(props = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                typeGroupById: new Map([['s2', 'branch']]),
                stepTypeById: new Map([['s2', 'condition']]),
                stepNumberById: new Map([['s2', 2]]),
            }}>
                <StepNodeBase nodeId="s2" icon={null} typeLabel="Condition" name="1. Modus bepalen voor deze aanvraag" sub="Trigger ▸ output ▸ mode" {...props} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

describe('StepNodeBase — readable at every zoom level', () => {
    beforeEach(() => { cleanup(); lod.value = 'near'; });

    it('up close, the name may take two lines and the badge sits in the corner', () => {
        renderCard({ runStep: { status: 'success' } });
        expect(screen.getByTestId('node-name').className).toContain('line-clamp-2');
        expect(screen.getByTestId('node-name').className).not.toContain('truncate');
        const slot = screen.getByTestId('node-badge-slot');
        expect(slot.className).toContain('absolute');
        expect(screen.getByTestId('node-status-badge').textContent).toBe('done');
    });

    it('at the middle distance the name wraps and the description is still there', () => {
        lod.value = 'mid';
        renderCard();
        expect(screen.getByTestId('node-name').className).toContain('line-clamp-2');
        expect(screen.getByTestId('node-sub').textContent).toBe('Trigger ▸ output ▸ mode');
    });

    it('zoomed right out it is the NAME that is large — not the type word', () => {
        lod.value = 'far';
        renderCard();
        const far = screen.getByTestId('node-far-label');
        expect(far.textContent).toContain('1. Modus bepalen voor deze aanvraag');
        expect(far.className).toContain('text-[22px]');
        expect(far.className).toContain('line-clamp-2');
        expect(screen.queryByText('Condition')).toBeNull();
    });
});
