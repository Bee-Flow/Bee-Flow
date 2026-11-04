import { render, screen, cleanup, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import InputDataPanelJs from './InputDataPanel';
import { buildRealOutputMap, buildSampleRoot } from './realOutputs';
import { computeUpstreamGroups } from './upstream';
import previewBinding from './bindingPreview';
import type { UpstreamDefinition } from './upstream/upstream.types';

const InputDataPanel = InputDataPanelJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * The Comes-in column of a step after a form trigger, before and after a form
 * test: the form's questions describe the trigger with design-time examples
 * ("visitor@example.com") until a run enters it, and then the answers the run
 * used are the values, in the column and in the example line of a binding.
 * Examples carry a "sample" chip so they are never read as run data.
 */
const DEF = {
    trigger: {
        id: 'trg', type: 'trigger', kind: 'form', label: 'Get in touch',
        form: { title: 'Get in touch', fields: [{ name: 'name', type: 'text', label: 'Your name' }, { name: 'email', type: 'email', label: 'Email' }] },
    },
    steps: [{ id: 'sum', type: 'form_page', mode: 'ending', label: 'Show a summary' }],
    edges: [{ from: 'trg', to: 'sum' }],
} as unknown as UpstreamDefinition;

/** What the drawer computes for `sum` with this run on the canvas (useBuildTabModel → useNodeDetailData). */
function panelData(run: Record<string, unknown> | null) {
    const real = buildRealOutputMap(DEF as never, [], run);
    const groups = computeUpstreamGroups(DEF, 'sum', null, real);
    return { groups, previewSample: buildSampleRoot(groups) };
}

const triggerBlock = () => screen.getAllByTestId('input-group').find(g => g.getAttribute('data-family') === 'trigger' && g.textContent?.includes('Email')) as HTMLElement;

describe('InputDataPanel — a form trigger before and after a form test', () => {
    beforeEach(cleanup);

    it('before any run: the examples carry a sample chip and the hint does not claim a run', () => {
        const { groups, previewSample } = panelData(null);
        render(<InputDataPanel groups={groups} previewSample={previewSample} onPick={vi.fn()} />);
        const block = triggerBlock();
        expect(within(block).getByText('visitor@example.com')).toBeTruthy();
        expect(within(block).getAllByTestId('field-sample-chip').length).toBe(2);
        expect(screen.queryByText(/Values come from the last run/)).toBeNull();
        expect(screen.getByText(/Values marked sample are examples/)).toBeTruthy();
    });

    it('after a run entered the form with answers: those are the values, without a chip', () => {
        const run = { id: 'r1', rootStepId: 'trg', triggerPayload: { name: 'Ada Lovelace', email: 'ada@example.org' } };
        const { groups, previewSample } = panelData(run);
        render(<InputDataPanel groups={groups} previewSample={previewSample} onPick={vi.fn()} />);
        const block = triggerBlock();
        expect(within(block).getByText('ada@example.org')).toBeTruthy();
        expect(within(block).getByText(/Ada Lovelace/)).toBeTruthy();
        expect(within(block).queryByText('visitor@example.com')).toBeNull();
        expect(within(block).queryByTestId('field-sample-chip')).toBeNull();
        expect(screen.getByText(/Values come from the last run/)).toBeTruthy();
    });

    it('the example line of a binding renders the run\'s answers, not the placeholders', () => {
        const binding = { kind: 'template', value: 'Thanks: {{trigger.output.email}} {{trigger.output.name}}' } as const;
        expect(previewBinding(binding, panelData(null).previewSample)).toBe('Thanks: visitor@example.com Your name');
        const run = { id: 'r1', rootStepId: 'trg', triggerPayload: { name: 'Ada', email: 'ada@example.org' } };
        expect(previewBinding(binding, panelData(run).previewSample)).toBe('Thanks: ada@example.org Ada');
    });

    it('a run with an empty payload, or one that entered elsewhere, leaves the examples', () => {
        expect(panelData({ id: 'r2', rootStepId: 'trg', triggerPayload: {} }).groups[0].hasRealData).toBeFalsy();
        expect(panelData({ id: 'r3', rootStepId: 'layer_in', triggerPayload: { name: 'X' } }).groups[0].hasRealData).toBeFalsy();
        expect(panelData({ id: 'r4', triggerPayload: { name: 'X' } }).groups[0].hasRealData).toBeFalsy();
    });
});
