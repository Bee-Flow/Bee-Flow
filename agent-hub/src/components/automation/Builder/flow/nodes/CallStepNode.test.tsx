import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CallStepNode from './CallStepNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';
import { partial } from '@/test/mocks';

/**
 * A call_block card used to read "3 inputs: klant_naam, bedrag, datum" — the
 * raw parameter keys of a Step a colleague wrote, printed straight onto the
 * canvas. The card shows the sentence, the tooltip keeps the exact value: the
 * keys are humanised where they are read and survive, unabridged, in the
 * card's `title`, because the mapping underneath is still written in them.
 */
const STEP = {
    id: 'cb1', type: 'call_block', blockId: 'b1', label: 'Send invoice',
    inputs: { klant_naam: {}, bedrag: {}, datum: {} },
};

function renderNode({ step = STEP, rt = {} } = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(),
                disabledById: new Set(),
                triggerIds: new Set(),
                attachedIds: new Set(),
                ...rt,
            }}>
                <CallStepNode id="cb1" data={{ step, runStep: null, issues: { errors: [], warnings: [] } }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const subLine = () => screen.getByTestId('node-sub');

describe('CallStepNode — the mapped inputs', () => {
    beforeEach(cleanup);

    it('reads the parameter keys as words, not as identifiers', () => {
        renderNode();
        expect(subLine().textContent).toBe('3 inputs: Klant naam, Bedrag, Datum');
    });

    it('keeps the exact keys in the tooltip, in full', () => {
        renderNode();
        // Demoted, never deleted: whoever writes the mapping needs `klant_naam`
        // spelled the way the Step declares it.
        expect(subLine().getAttribute('title')).toBe('3 inputs: klant_naam, bedrag, datum');
    });

    it('does not truncate the tooltip at four, the way the card line does', () => {
        const inputs: Record<string, unknown> = {};
        for (const k of ['klant_naam', 'bedrag', 'datum', 'btw_bedrag', 'referentie']) inputs[k] = {};
        renderNode(partial<Parameters<typeof renderNode>[0]>({ step: { ...STEP, inputs } }));
        expect(subLine().textContent).toBe('5 inputs: Klant naam, Bedrag, Datum, Btw bedrag…');
        expect(subLine().getAttribute('title'))
            .toBe('5 inputs: klant_naam, bedrag, datum, btw_bedrag, referentie');
    });

    it('says so plainly when nothing is mapped', () => {
        renderNode(partial<Parameters<typeof renderNode>[0]>({ step: { ...STEP, inputs: {} } }));
        expect(subLine().textContent).toBe('no inputs mapped');
    });
});

describe('CallStepNode — what the Step is for', () => {
    beforeEach(cleanup);

    const rt = { blockSummaries: { b1: 'Mails the invoice to the customer.' } };

    it('puts the Step\'s own description in front of the arity', () => {
        renderNode({ rt });
        expect(subLine().textContent).toBe('Mails the invoice to the customer. · 3 inputs: Klant naam, Bedrag, Datum');
    });

    it('carries both the description and the exact keys into the tooltip', () => {
        renderNode({ rt });
        expect(subLine().getAttribute('title'))
            .toBe('Mails the invoice to the customer. · 3 inputs: klant_naam, bedrag, datum');
    });

    it('shows the description alone when no input is mapped', () => {
        renderNode(partial<Parameters<typeof renderNode>[0]>({ step: { ...STEP, inputs: {} }, rt }));
        expect(subLine().textContent).toBe('Mails the invoice to the customer.');
    });
});

describe('CallStepNode — the drill-in', () => {
    beforeEach(cleanup);

    it('still opens the Step in its own builder', async () => {
        const user = userEvent.setup();
        const onOpenBlock = vi.fn();
        renderNode({ rt: { onOpenBlock } });
        await user.click(screen.getByRole('button', { name: /open step/i }));
        expect(onOpenBlock).toHaveBeenCalledWith('b1');
    });
});
