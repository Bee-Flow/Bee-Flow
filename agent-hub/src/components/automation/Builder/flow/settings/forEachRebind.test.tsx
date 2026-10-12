import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoopFields as LoopFieldsJs } from './actionEditors/loopFields';
import { ForEachSection as ForEachSectionJs } from './collectionEditors';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

// JS components: their props type from their defaults, looser than what they take.
const ForEachSection = ForEachSectionJs as unknown as React.FC<Record<string, unknown>>;
const LoopFields = LoopFieldsJs as unknown as React.FC<Record<string, unknown>>;

const SEARCH = { id: 's1', label: 'Search', kind: 'integration_action', basePath: 'steps.s1.output', sample: { messages: [{ ID: 'x', Subject: 's' }] }, fields: [{ key: 'messages', path: 'steps.s1.output.messages', sample: [{ ID: 'x', Subject: 's' }] }] };
const READ = {
    id: 's2', label: 'Read mail', kind: 'integration_action', basePath: 'steps.s2.output', forEach: true,
    sample: { iterations: 0, results: [{ index: 0, item: {}, output: { id: 'm1', attachments: [{ attachmentId: 'a1' }] }, status: 'success' }] },
    fields: [{ key: 'results', path: 'steps.s2.output.results', sample: [{ index: 0, output: { id: 'm1' } }] }],
};
const GROUPS = [SEARCH, READ];

function wrap(node: React.ReactNode) {
    return render(
        <VariablePickerProvider groups={GROUPS} previewSample={null} stepLabelById={new Map([['s1', 'Search'], ['s2', 'Read mail']])} stepTypeById={new Map()}>
            {node}
        </VariablePickerProvider>,
    );
}

afterEach(() => cleanup());

describe('"Run once per item": another list, and the fields follow', () => {
    it('a list inside the current one keeps the outer item: parents written, fields untouched', async () => {
        const set = vi.fn();
        const draft = { forEach: { overRef: 'steps.s2.output.results', itemVar: 'result', maxIterations: 100 }, inputs: { messageId: { kind: 'ref', path: 'loop.result.output.id' } } };
        wrap(<ForEachSection draft={draft} set={set} groups={GROUPS} />);
        await userEvent.setup().click(screen.getByTitle('steps.s2.output.results[*].output.attachments'));
        expect(set).toHaveBeenCalledWith('forEach', {
            overRef: 'steps.s2.output.results[*].output.attachments', itemVar: 'attachment', maxIterations: 100,
            parents: [{ itemVar: 'result', overRef: 'steps.s2.output.results' }],
        });
        expect(set.mock.calls.some(c => c[0] === 'inputs')).toBe(false);
    });

    it('another list renames the item and moves inputs and prompt by field name', async () => {
        const set = vi.fn();
        const draft = {
            forEach: { overRef: 'steps.s2.output.results', itemVar: 'result', maxIterations: 100 },
            prompt: 'About {{loop.result.subject}}',
            inputs: { id: { kind: 'ref', path: 'loop.result.id' } },
        };
        wrap(<ForEachSection draft={draft} set={set} groups={GROUPS} />);
        await userEvent.setup().click(screen.getByTitle('steps.s1.output.messages'));
        expect(set).toHaveBeenCalledWith('forEach', expect.objectContaining({ overRef: 'steps.s1.output.messages', itemVar: 'message' }));
        expect(set).toHaveBeenCalledWith('prompt', 'About {{loop.message.Subject}}');
        expect(set).toHaveBeenCalledWith('inputs', { id: { kind: 'ref', path: 'loop.message.ID' } });
    });

    it('a Loop: the steps inside follow its item', async () => {
        const set = vi.fn();
        const draft = { type: 'loop', overRef: 'steps.s2.output.results', itemVar: 'result', body: [{ id: 'n1', type: 'notification', title: '{{ loop.result.subject }}', body: '' }] };
        wrap(<LoopFields draft={draft} set={set} groups={GROUPS} previewSample={null} catalog={null} />);
        await userEvent.setup().click(screen.getByTitle('steps.s1.output.messages'));
        expect(set).toHaveBeenCalledWith('overRef', 'steps.s1.output.messages');
        expect(set).toHaveBeenCalledWith('itemVar', 'message');
        expect(set).toHaveBeenCalledWith('body', [{ id: 'n1', type: 'notification', title: '{{ loop.message.Subject }}', body: '' }]);
    });
});
