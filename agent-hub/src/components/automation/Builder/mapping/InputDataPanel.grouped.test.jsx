import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import InputDataPanel from './InputDataPanel';

/**
 * The Incoming column after the builder redesign (artboards 2a/2b): one block
 * per source step with its number and family, a field count with how many are
 * already in use, kinds in plain words, and a `Per step | All` switch.
 */
const GROUPS = [
    { id: 'trigger', kind: 'trigger', label: 'New email', basePath: 'trigger.output', fields: [
        { key: 'email', path: 'trigger.output.email', sample: 'a@b.nl' },
    ] },
    { id: 's1', kind: 'integration_action', label: 'Gmail search', basePath: 'steps.s1.output', fields: [
        { key: 'results', path: 'steps.s1.output.results', sample: [{ subject: 'Contract' }] },
        { key: 'count', path: 'steps.s1.output.count', sample: 1 },
    ] },
];
const SAMPLE = { trigger: { output: { email: 'a@b.nl' } }, steps: { s1: { output: { results: [{ subject: 'Contract' }], count: 1 } } } };

const renderPanel = (props = {}) => render(
    <InputDataPanel
        groups={GROUPS}
        previewSample={SAMPLE}
        onPick={() => {}}
        stepTypeById={new Map([['s1', 'integration_action']])}
        stepNumberById={new Map([['trigger', 1], ['s1', 2]])}
        {...props}
    />,
);

describe('InputDataPanel — grouped by step', () => {
    beforeEach(cleanup);

    it('names each block by its step number and wears the family', () => {
        renderPanel();
        expect(screen.getByText(/Step 2/)).toBeTruthy();
        const blocks = screen.getAllByTestId('input-group');
        // Nearest step first; the trigger, being furthest, comes last.
        expect(blocks[0].getAttribute('data-family')).toBe('app');
        expect(blocks[1].getAttribute('data-family')).toBe('trigger');
    });

    it('counts the fields and says how many this step already uses', () => {
        renderPanel({ usedPaths: new Set(['steps.s1.output.count']) });
        expect(screen.getByText('2 fields · 1 in use')).toBeTruthy();
        expect(screen.getByText('1 field')).toBeTruthy();
        expect(screen.getByTestId('field-used-pill').textContent).toBe('used');
    });

    it('speaks in kinds, never in type names', () => {
        renderPanel();
        expect(screen.getByText('number')).toBeTruthy();
        expect(screen.getByText('table · 1 row · 1 column')).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/\b(array|object|string)\b/);
    });

    it('"All" flattens every field into one list, "Per step" groups them again', () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'All' }));
        const all = screen.getByTestId('input-all-fields');
        expect(all.textContent).toContain('Email');
        expect(all.textContent).toContain('Count');
        expect(screen.queryAllByTestId('input-group')).toHaveLength(0);
        fireEvent.click(screen.getByRole('button', { name: 'Per step' }));
        expect(screen.getAllByTestId('input-group')).toHaveLength(2);
    });

    it('keeps the group label a direct child of the draggable header', () => {
        renderPanel();
        const header = screen.getByText('Gmail search').parentElement;
        expect(header.getAttribute('draggable')).toBe('true');
    });
});
