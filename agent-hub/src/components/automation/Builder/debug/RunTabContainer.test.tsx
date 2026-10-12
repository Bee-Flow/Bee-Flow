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

describe('a Condition that works through a list (P1-P3)', () => {
    const mails = [{ subject: 'Invoice 1' }, { subject: 'Invoice 2' }, { subject: 'Invoice 3' }];
    const filter = { id: 'cond', type: 'filter', label: 'Condition', arrayRef: 'steps.read.output.messages', expr: 'true' };
    const split = {
        id: 'split', type: 'switch', label: 'Condition', arrayRef: 'steps.read.output.messages[*].attachments', routeStyle: 'rules',
        cases: [{ name: 'pdf', expr: 'a' }, { name: 'word', expr: 'b' }, { name: 'powerpoint', expr: 'c' }],
    };

    it('a filter opens its output with "Kept 3 of 4 messages" and no count chips', () => {
        render(<RunTabContainer step={filter} runStep={{ status: 'success', output: { items: mails, count: 3, inputCount: 4, rejectedCount: 1 } }} />);
        expect(screen.getByTestId('output-route-note').textContent).toBe('Kept 3 of 4 messages');
        expect(screen.queryByText('Rejected count')).toBeNull();
        expect(screen.queryByText('Input count')).toBeNull();
    });

    it('a list switch says how it split the attachments, in case order', () => {
        const output = {
            mode: 'collection', branch: 'case:pdf', branches: ['case:pdf'], matchesByCase: {},
            counts: { word: 2, pdf: 4, powerpoint: 1, default: 4 }, total: 11, matched: 'pdf',
        };
        render(<RunTabContainer step={split} runStep={{ status: 'success', output }} />);
        expect(screen.getByTestId('output-route-note').textContent).toBe('pdf 4 · word 2 · powerpoint 1 · Otherwise 4 (11 attachments in all)');
    });

    it('a list switch shows its outputs, by name, and counts the attachments in the strip', () => {
        const att = (name: string) => ({ filename: name, mimeType: 'application/pdf' });
        const output = {
            mode: 'collection', branch: 'case:pdf', branches: ['case:pdf', 'case:default'],
            matchesByCase: { default: [att('logo.png')], pdf: [att('a.pdf'), att('b.pdf')] },
            counts: { pdf: 2, default: 1 }, total: 3, matched: 'pdf,default',
        };
        render(<RunTabContainer step={split} runStep={{ status: 'success', output }} />);
        expect(screen.getByTestId('output-status-strip').textContent).toContain('3 attachments');
        const fields = screen.getByTestId('output-fields');
        expect(within(fields).getByText('pdf')).toBeTruthy();
        expect(within(fields).getByText('Otherwise')).toBeTruthy();
        for (const internal of ['mode', 'branch', 'branches', 'matchesByCase', 'counts', 'matched', 'default']) {
            expect(within(fields).queryByText(internal)).toBeNull();
        }
    });

    it('any other step has no route line', () => {
        render(<RunTabContainer step={list} runStep={{ status: 'success', output: { items: mails, count: 3, inputCount: 4, rejectedCount: 1 } }} />);
        expect(screen.queryByTestId('output-route-note')).toBeNull();
    });
});
