import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import HttpRequestNode from './HttpRequestNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/** The web service call card's summary line: method and url, as bindings or plain strings. */
function renderNode(step: Record<string, unknown>, stepLabelById: Map<string, string> | null = null) {
    const runtime = {
        pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
        typeGroupById: new Map([['s1', 'data']]), stepTypeById: new Map([['s1', 'http_request']]),
        stepNumberById: new Map([['s1', 2]]),
    };
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={runtime as never}>
                <HttpRequestNode id="s1" data={{ step: { id: 's1', type: 'http_request', label: 'Fetch invoice', ...step }, stepLabelById }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

beforeEach(cleanup);

describe('HttpRequestNode — summary', () => {
    it('reads a literal url binding as its text, not [object Object]', () => {
        renderNode({ method: { kind: 'literal', value: 'post' }, url: { kind: 'literal', value: 'https://example.com/a' } });
        expect(screen.getByTestId('node-sub').textContent).toBe('POST https://example.com/a');
    });

    it('shows a template url with its references named like chips', () => {
        renderNode({ url: { kind: 'template', value: 'https://example.com/{{trigger.id}}' } });
        expect(screen.getByTestId('node-sub').textContent).toBe('GET https://example.com/Trigger ▸ Id');
    });

    it('names a reference in the url the way the chip does', () => {
        renderNode({ url: { kind: 'template', value: 'https://example.com/{{steps.code_1.output.result.id}}' } }, new Map([['code_1', 'Code']]));
        expect(screen.getByTestId('node-sub').textContent).toBe('GET https://example.com/Code ▸ Id');
    });

    it('still reads a plain string url', () => {
        renderNode({ method: 'get', url: 'https://example.com' });
        expect(screen.getByTestId('node-sub').textContent).toBe('GET https://example.com');
    });

    it('says no URL is set when the binding is empty', () => {
        renderNode({ url: { kind: 'literal', value: '' } });
        expect(screen.getByTestId('node-sub').textContent).toBe('GET · no URL set');
    });
});
