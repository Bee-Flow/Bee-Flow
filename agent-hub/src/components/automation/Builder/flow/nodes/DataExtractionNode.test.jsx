import { render, screen, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, it, expect, beforeEach } from 'vitest';
import DataExtractionNode from './DataExtractionNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';
import { dataExtractionSummary } from '../nodeSummaries';

/**
 * The Extract data card: the AI family's chrome, no tools port, and at a
 * glance HOW MANY fields it pulls out and WHICH — the two things that tell two
 * extraction cards under one loop apart.
 */
function renderNode(step) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{ pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set() }}>
                <DataExtractionNode id={step.id} data={{ step, runStep: null, issues: { errors: [], warnings: [] }, stepLabelById: new Map() }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

describe('DataExtractionNode', () => {
    beforeEach(cleanup);

    it('shows the field count and the field names', () => {
        renderNode({
            id: 'ex_1', type: 'data_extraction', label: 'Read the invoice',
            fields: [{ name: 'datum', type: 'date' }, { name: 'totaal', type: 'number' }, { name: '', type: 'string' }],
        });
        expect(screen.getByText('Read the invoice')).toBeTruthy();
        expect(screen.getByText('2 fields')).toBeTruthy();   // the blank seed row does not count
        expect(screen.getByText('datum · totaal')).toBeTruthy();
    });

    it('a fresh drop says what is missing, in words, with no count chip and no tools port', () => {
        renderNode({ id: 'ex_1', type: 'data_extraction', fields: [{ name: '', type: 'string' }] });
        // Type label and default name are both "Extract data" — read the name slot.
        expect(screen.getByTestId('node-name').textContent).toBe('Extract data');
        expect(screen.getByText('no fields yet')).toBeTruthy();
        expect(screen.queryByText(/fields$/)).toBeNull();
        expect(screen.queryByText(/tools/)).toBeNull();
    });

    it('wears the for-each chip when it fans out over a list', () => {
        renderNode({ id: 'ex_1', type: 'data_extraction', fields: [{ name: 'a' }], forEach: { overRef: 'steps.read.output.results', itemVar: 'f' } });
        expect(screen.getByText('for each')).toBeTruthy();
    });
});

describe('dataExtractionSummary', () => {
    it('names up to six fields and counts the rest', () => {
        expect(dataExtractionSummary({ fields: [{ name: 'a' }, { name: ' b ' }, { name: '' }, null] })).toBe('a · b');
        const eight = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}` }));
        expect(dataExtractionSummary({ fields: eight })).toBe('f0 · f1 · f2 · f3 · f4 · f5 · +2');
        expect(dataExtractionSummary({ fields: [] })).toEqual({ muted: 'no fields yet' });
        expect(dataExtractionSummary({})).toEqual({ muted: 'no fields yet' });
    });
});
