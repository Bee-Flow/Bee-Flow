import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoopOverPickerJs from './LoopOverPicker';
import { VariablePickerProvider } from './VariablePickerContext';

// A JS component: its props type from their defaults (`onRebind = null`), looser than what it takes.
const LoopOverPicker = LoopOverPickerJs as unknown as React.FC<Record<string, unknown>>;

const READ = {
    id: 's2', label: 'Read mail', kind: 'integration_action', basePath: 'steps.s2.output', forEach: true,
    sample: { iterations: 0, results: [{ index: 0, item: {}, output: { id: 'm1', subject: 'Hi', attachments: [{ attachmentId: 'a1', filename: 'x.pdf' }] }, status: 'success' }] },
    fields: [{ key: 'results', path: 'steps.s2.output.results', sample: [{ index: 0, output: { id: 'm1' } }] }],
};
const SEARCH = { id: 's1', label: 'Search', kind: 'integration_action', basePath: 'steps.s1.output', sample: { messages: [{ ID: 'x', Subject: 's' }] }, fields: [{ key: 'messages', path: 'steps.s1.output.messages', sample: [{ ID: 'x', Subject: 's' }] }] };
// The step's own item: never a list to repeat over.
const OWN = { id: 's3__foreach', label: 'Current item (result)', kind: 'loop', basePath: 'loop.result', ownItem: true, sample: { attachments: [{ a: 1 }] }, fields: [{ key: 'attachments', path: 'loop.result.attachments', sample: [{ a: 1 }] }] };
const labels = new Map([['s1', 'Search'], ['s2', 'Read mail']]);

function setup(props: Record<string, unknown> = {}) {
    const onChange = vi.fn();
    const onRebind = vi.fn();
    const groups = [SEARCH, READ, OWN];
    render(
        <VariablePickerProvider groups={groups} previewSample={null} stepLabelById={labels} stepTypeById={new Map()}>
            <LoopOverPicker overRef="steps.s2.output.results" itemVar="result" onChange={onChange} groups={groups} onRebind={onRebind} {...props} />
        </VariablePickerProvider>,
    );
    return { onChange, onRebind, user: userEvent.setup() };
}

afterEach(() => cleanup());

describe('LoopOverPicker: switching the list', () => {
    it('never offers the step\'s own item, does offer a list inside each row, and labels it in words', () => {
        setup({ bindings: {} });
        const options = screen.getAllByRole('button').map(b => b.getAttribute('title')).filter(Boolean);
        expect(options).not.toContain('loop.result.attachments');
        expect(options).toContain('steps.s2.output.results[*].output.attachments');
        expect(screen.getByText('Read mail ▸ Results ▸ Attachments (inside each row)')).toBeTruthy();
        // The chosen list reads the same way, never as a path.
        expect(screen.queryByText(/\[\*\]/)).toBeNull();
    });

    it('a list inside the current one keeps the current item: fields untouched, Undo restores', async () => {
        const bindings = { messageId: { kind: 'ref', path: 'loop.result.output.id' } };
        const { onChange, onRebind, user } = setup({ bindings });
        await user.click(screen.getByTitle('steps.s2.output.results[*].output.attachments'));
        expect(onChange).toHaveBeenLastCalledWith({
            overRef: 'steps.s2.output.results[*].output.attachments', itemVar: 'attachment',
            parents: [{ itemVar: 'result', overRef: 'steps.s2.output.results' }],
        });
        expect(onRebind).not.toHaveBeenCalled();
        expect(screen.getByRole('status').textContent).toMatch(/keep reading it/);
        await user.click(screen.getByText('Undo'));
        expect(onChange).toHaveBeenLastCalledWith({ overRef: 'steps.s2.output.results', itemVar: 'result', parents: undefined });
    });

    it('another list renames the item and moves fields by name, reporting the rest', async () => {
        const bindings = { subject: { kind: 'ref', path: 'loop.result.output.subject' }, title: { kind: 'ref', path: 'loop.result.subject' } };
        const { onChange, onRebind, user } = setup({ bindings });
        await user.click(screen.getByTitle('steps.s1.output.messages'));
        expect(onChange).toHaveBeenLastCalledWith({ overRef: 'steps.s1.output.messages', itemVar: 'message', parents: undefined });
        expect(onRebind).toHaveBeenLastCalledWith({ subject: bindings.subject, title: { kind: 'ref', path: 'loop.message.Subject' } });
        expect(screen.getByRole('status').textContent).toMatch(/nothing for subject/);
        await user.click(screen.getByText('Undo'));
        expect(onRebind).toHaveBeenLastCalledWith(bindings);
    });
});

describe('LoopOverPicker: counts', () => {
    it('says "1 item", not "1 items"', () => {
        const groups = [{ id: 's1', label: 'Search', kind: 'integration_action', basePath: 'steps.s1.output', sample: { one: [{ a: 1 }], three: [{ a: 1 }, { a: 2 }, { a: 3 }] }, fields: [] }];
        render(
            <VariablePickerProvider groups={groups} previewSample={{ steps: { s1: { output: groups[0].sample } } }} stepLabelById={labels} stepTypeById={new Map()}>
                <LoopOverPicker overRef="" itemVar="item" onChange={vi.fn()} groups={groups} />
            </VariablePickerProvider>,
        );
        expect(screen.getByText('1 item')).toBeTruthy();
        expect(screen.getByText('3 items')).toBeTruthy();
        expect(screen.queryByText('1 items')).toBeNull();
    });
});
