import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import AiStepNode from './AiStepNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * The three AI step cards (handoff 5, round 3, artboard 3b): loose
 * instruction, agent, skill without an agent; and the ports under the card
 * that open the agent, skill or knowledge base in Studio.
 */
interface RenderOpts { agentNameById?: Record<string, string>; onNavigate?: (target: string) => void }

function renderNode(step: Record<string, unknown>, { agentNameById = { agt: 'Quote assistant' }, onNavigate }: RenderOpts = {}) {
    const runtime = {
        pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
        typeGroupById: new Map([['s1', 'ai']]), stepTypeById: new Map([['s1', 'ai_step']]),
        stepNumberById: new Map([['s1', 3]]), onNavigate,
    };
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={runtime as never}>
                <AiStepNode id="s1" data={{ step: { id: 's1', type: 'ai_step', label: 'Judge photos', ...step }, agentNameById }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

beforeEach(cleanup);

describe('AiStepNode — variants', () => {
    it('a loose instruction shows the prompt and no ports row', () => {
        renderNode({ prompt: 'Summarise the mail' });
        expect(screen.getByTestId('node-sub').textContent).toBe('Summarise the mail');
        expect(screen.queryByTestId('node-ports-row')).toBeNull();
    });

    it('an agent step reads "AI step · agent" with the agent, skills and tools', () => {
        renderNode({ agentId: 'agt', skillIds: ['sk1'], tools: ['a', 'b'] });
        expect(screen.getByText('AI step · agent')).toBeTruthy();
        expect(screen.getByTestId('node-sub').textContent).toBe('Quote assistant · 1 skill · 2 tools');
        const row = screen.getByTestId('node-ports-row');
        expect(within(row).getByRole('link', { name: /Quote assistant/ }).getAttribute('href')).toBe('/app/studio/agents/agt');
        expect(within(row).getByRole('link', { name: /1 skill/ }).getAttribute('href')).toBe('/app/studio/skills/sk1');
        // The tool port stays the drop target, as the row's last chip.
        expect(row.querySelector('[data-tool-port="s1"]')).toBeTruthy();
    });

    it('a skill without an agent reads "AI step · skill · no agent"', () => {
        renderNode({ skillIds: ['sk1'], knowledgeBaseIds: ['kb1', 'kb2'] });
        expect(screen.getByText('AI step · skill')).toBeTruthy();
        expect(screen.getByTestId('node-sub').textContent).toBe('skill · no agent');
        expect(screen.getByRole('link', { name: /2 knowledge/ }).getAttribute('href')).toBe('/app/studio/knowledge/kb1');
    });

    it('a port opens Studio in-app when the canvas offers onNavigate', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        renderNode({ agentId: 'agt' }, { onNavigate });
        await user.click(screen.getByRole('link', { name: /Quote assistant/ }));
        expect(onNavigate).toHaveBeenCalledWith('studio/agents/agt');
    });
});
