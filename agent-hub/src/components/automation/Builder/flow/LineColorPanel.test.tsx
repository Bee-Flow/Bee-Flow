import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import LineColorPanel from './LineColorPanel';

/**
 * The Lines panel: the discoverable home for colour rules. Its contract —
 * every lens is always selectable (PII included, with an explanation instead
 * of a dead button), case rules pin edge colours, PII rows edit
 * definition.piiLineColors, and read-only canvases can look but not touch.
 */

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        {
            id: 'sw', type: 'switch', expr: 'x', label: 'Sort documents',
            cases: [{ name: 'pdf', value: 'pdf' }, { name: 'word', value: 'word' }],
        },
    ],
    edges: [
        { from: 'trg', to: 'sw' },
        { from: 'sw', to: 'n1', label: 'case:pdf', caseName: 'pdf' },
        { from: 'sw', to: 'n2', label: 'case:word', caseName: 'word' },
    ],
};

function renderPanel(props = {}) {
    const onModeChange = vi.fn();
    const onDefinitionChange = vi.fn();
    render(
        <LineColorPanel
            mode="branches"
            onModeChange={onModeChange}
            definition={DEF}
            editable
            onDefinitionChange={onDefinitionChange}
            hasPiiData={false}
            {...props}
        />,
    );
    return { onModeChange, onDefinitionChange };
}

const openPanel = async () => {
        const user = userEvent.setup();
        await user.click(screen.getByLabelText('Line colour rules'));
    };

describe('LineColorPanel', () => {
    beforeEach(cleanup);

    it('every lens is selectable — PII is never a dead button', async () => {
        const user = userEvent.setup();
        const { onModeChange } = renderPanel();
        for (const label of ['Off', 'Branches', 'PII']) {
            const btn = screen.getByText(label);
            expect((btn as HTMLInputElement).disabled).toBe(false);
            await user.click(btn);
        }
        expect(onModeChange.mock.calls.map(c => c[0])).toEqual(['off', 'branches', 'pii']);
    });

    it('lists every routing rule with its step, and explains PII when no data exists', async () => {
        renderPanel();
        await openPanel();
        expect(screen.getByText('pdf')).toBeTruthy();
        expect(screen.getByText('word')).toBeTruthy();
        expect(screen.getAllByText('· Sort documents').length).toBe(2);
        expect(screen.getByText(/No PII data yet/)).toBeTruthy();
        expect(screen.getByText(/Privacy\s+Shield applied to automations/)).toBeTruthy();
        // All seven PII groups are in the legend.
        for (const g of ['Personal', 'Contact', 'Financial', 'Identity', 'Digital', 'Organization', 'EU / Netherlands']) {
            expect(screen.getByText(g)).toBeTruthy();
        }
    });

    it('pinning a case colour writes edge.color on every edge of that case', async () => {
        const user = userEvent.setup();
        const { onDefinitionChange } = renderPanel();
        await openPanel();
        await user.click(screen.getByLabelText('Change the colour of pdf'));
        await user.click(screen.getByLabelText('Colour pdf red'));
        const next = onDefinitionChange.mock.calls[0][0];
        expect(next.edges.find((e: { caseName?: string }) => e.caseName === 'pdf')!.color).toBe('red');
        expect(next.edges.find((e: { caseName?: string }) => e.caseName === 'word')!.color).toBeUndefined();
    });

    it('remapping a PII group writes definition.piiLineColors; auto clears it', async () => {
        const user = userEvent.setup();
        const { onDefinitionChange } = renderPanel();
        await openPanel();
        await user.click(screen.getByLabelText('Change the colour of Contact'));
        await user.click(screen.getByLabelText('Colour Contact cyan'));
        expect(onDefinitionChange.mock.calls[0][0].piiLineColors).toEqual({ Contact: 'cyan' });
    });

    it('read-only canvases see the rules but get no editing affordance', async () => {
        renderPanel({ editable: false });
        await openPanel();
        expect(screen.queryByLabelText('Change the colour of pdf')).toBeNull();
        expect(screen.getByText('pdf')).toBeTruthy(); // legend still readable
    });

    it('the hint disappears once PII data exists', async () => {
        renderPanel({ hasPiiData: true });
        await openPanel();
        expect(screen.queryByText(/No PII data yet/)).toBeNull();
    });
});
