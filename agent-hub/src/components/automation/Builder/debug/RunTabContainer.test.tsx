import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import RunTabContainer from './RunTabContainer';

const list = { id: 'list', type: 'action', label: 'List files' };
const definition = {
    trigger: { id: 't1', type: 'trigger', kind: 'manual' },
    steps: [
        list,
        { id: 'read', type: 'ai_step', label: 'Read the invoice', prompt: '{{steps.list.output.files[*].name}}' },
    ],
    edges: [{ from: 't1', to: 'list' }, { from: 'list', to: 'read' }],
};
const lonely = { trigger: definition.trigger, steps: [list], edges: [{ from: 't1', to: 'list' }] };
const FILES = { files: [{ name: 'a.pdf', path: '/a.pdf', size: 10 }, { name: 'b.pdf', path: '/b.pdf', size: 20 }] };

beforeEach(() => cleanup());

describe('the Continues-on column', () => {
    it('before the first run: what the step will return, each "no value yet"', () => {
        render(<RunTabContainer step={list} runStep={null} definition={lonely} describedSample={{ text: '<string>', pageCount: 0 }} />);
        const expected = screen.getByTestId('output-expected-fields');
        expect(within(expected).getByText('This step will return')).toBeTruthy();
        expect(within(expected).getByText('Page count')).toBeTruthy();
        expect(within(expected).getAllByText('no value yet')).toHaveLength(2);
    });

    it('says which later step uses which fields', () => {
        render(<RunTabContainer step={list} runStep={{ status: 'success', output: FILES }} definition={definition} />);
        const used = screen.getByTestId('output-used-by');
        expect(used.textContent).toContain('Read the invoice');
        expect(used.textContent).toContain('Name');
    });

    it('asks what to do with an unused list, and adds the answer after this step', async () => {
        const user = userEvent.setup();
        const onAddAfterStep = vi.fn();
        render(<RunTabContainer step={list} runStep={{ status: 'success', output: FILES }} definition={lonely} onAddAfterStep={onAddAfterStep} />);
        expect(screen.getByText('No step uses this list yet. What do you want to do with it?')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Do something for each file' }));
        expect(onAddAfterStep).toHaveBeenLastCalledWith('list', 'loop');
        await user.click(screen.getByRole('button', { name: 'Save in a datatable' }));
        expect(onAddAfterStep).toHaveBeenLastCalledWith('list', 'datatable');
        await user.click(screen.getByRole('button', { name: 'Other step' }));
        expect(onAddAfterStep).toHaveBeenLastCalledWith('list', null);
    });

    it('a failed step: the error card, the promised fields, and retry wired to the step', async () => {
        const user = userEvent.setup();
        const onRetryFromStep = vi.fn();
        render(
            <RunTabContainer
                step={list}
                runStep={{ status: 'error', output: null, error: 'HTTP 403', errorInfo: { title: 'Bee may not open this folder', fixes: [{ id: 'retry' }] } }}
                definition={lonely}
                describedSample={{ text: '<string>' }}
                onRetryFromStep={onRetryFromStep}
            />,
        );
        expect(screen.getByTestId('output-error-card')).toBeTruthy();
        expect(screen.getByTestId('output-expected-fields')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(onRetryFromStep).toHaveBeenCalledWith('list');
    });

    it('keeps the plain empty state when there is nothing to promise', () => {
        render(<RunTabContainer step={list} runStep={null} />);
        expect(screen.getByText(/No data yet/)).toBeTruthy();
    });
});
