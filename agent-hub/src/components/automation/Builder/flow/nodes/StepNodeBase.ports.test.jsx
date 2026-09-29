import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import StepNodeBase from './StepNodeBase';
import { NodeRuntimeContext } from '../NodeRuntimeContext';
import { cardHeightForPorts, CARD_H, PORT_PAD, PORT_PITCH } from '../nodeTypeColors';
import { toolLayoutHeights } from '../aiToolNodes';

/**
 * A card with more than two output ports grows a row per port (user feedback
 * 2026-09-03: a four-way condition crammed its four labels onto 72px). The
 * layout reads the same number, so dagre and the rows give it the room.
 */
function renderCard(props = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
                typeGroupById: new Map([['c1', 'branch']]),
                stepTypeById: new Map([['c1', 'switch']]),
                stepNumberById: new Map([['c1', 2]]),
            }}>
                <StepNodeBase nodeId="c1" icon={null} typeLabel="Condition" name="Modus bepalen" sub="Trigger ▸ output" {...props} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}
const cardEl = (container) => container.querySelector('.group');
const ports = (names) => names.map(n => ({ id: `case:${n}`, label: n, tone: 'case' }));

describe('StepNodeBase — a card grows with its output ports', () => {
    beforeEach(cleanup);

    it('two ports still fit the standard card', () => {
        const { container } = renderCard({ sourceHandles: ports(['match', 'otherwise']) });
        expect(cardEl(container).style.height).toBe(`${CARD_H}px`);
    });

    it('four ports get a row each — and each label sits on its own row', () => {
        const names = ['zelf', 'zoeken', 'strategie', 'otherwise'];
        const { container } = renderCard({ sourceHandles: ports(names) });
        const expected = 4 * PORT_PITCH + 2 * PORT_PAD;
        expect(cardEl(container).style.height).toBe(`${expected}px`);
        expect(cardHeightForPorts(4)).toBe(expected);
        const tops = names.map(n => parseFloat(container.querySelector(`[title="${n}"]`).style.top));
        for (let i = 1; i < tops.length; i += 1) expect(tops[i] - tops[i - 1]).toBe(PORT_PITCH);
        expect(tops[0]).toBe(PORT_PAD + PORT_PITCH / 2);
    });

    it('the layout box for a four-way switch grows by the same amount', () => {
        const steps = [
            { id: 'c1', type: 'switch', cases: [{ name: 'zelf' }, { name: 'zoeken' }, { name: 'strategie' }] },
            { id: 'c2', type: 'condition' },
            { id: 'a', type: 'set' },
        ];
        const heights = toolLayoutHeights(steps, 96);
        // switch: 3 cases + otherwise = 4 ports; the 24px of slack under the card stays.
        expect(heights.get('c1')).toBe(cardHeightForPorts(4) + 24);
        // a plain condition (then / else) and a set step keep the default box.
        expect(heights.has('c2')).toBe(false);
        expect(heights.has('a')).toBe(false);
    });
});
