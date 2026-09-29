import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistEvent, CodeAnalysis } from '../../../../../../api/queries/automation/codeStep';

const assistCalls: Array<{ code: string; last: string }> = [];
vi.mock('../../../../../../api/queries/automation/codeStep', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../../../../../api/queries/automation/codeStep')>();
    return {
        ...real,
        streamCodeAssist: async (req: { code: string; messages: Array<{ content: string }> }, onEvent: (e: AssistEvent) => void) => {
            assistCalls.push({ code: req.code, last: req.messages[req.messages.length - 1].content });
            onEvent({ type: 'delta', text: 'Done: added a minimum.' });
            onEvent({ type: 'edit', op: 'patch', summary: 'Added a minimum' });
            onEvent({ type: 'code', code: `${req.code}\n// minimum` });
            onEvent({ type: 'done' });
        },
    };
});
// Monaco is lazy and heavy; the plain box is the same editor for these tests.
vi.mock('@monaco-editor/react', () => { throw new Error('no chunk in tests'); });

import CodeLargeEditor from './CodeLargeEditor';
import { cleanHostEntry } from './CodeChecksPanel';
import { inputsFromValues, tryValuesFrom } from './CodeTryPanel';
import { historyOf, type AssistTurn } from './useCodeAssistChat';

const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const BLOCKED: CodeAnalysis = {
    ok: true, syntaxError: null, hash: 'h', rulesetVersion: 'code-safety/1', description: null, params: [], returns: null,
    findings: [{ ruleId: 'dynamic-code', severity: 'block', approver: null, line: 3, column: 1, endLine: null, endColumn: null,
        message: 'Code that writes and runs new code cannot be checked. Write the logic directly.', messageKey: null, fix: null, fixKey: null }],
    capabilities: { hosts: [], dynamicHosts: false, tools: [], inputsRead: [], undeclaredInputs: [], usesHttp: false, usesDb: false, httpInLoop: false },
    approvals: [], aiReview: null,
} as unknown as CodeAnalysis;

function editor(overrides: Partial<Parameters<typeof CodeLargeEditor>[0]> = {}) {
    const set = vi.fn();
    const onClose = vi.fn();
    wrap(
        <CodeLargeEditor
            initialTab="assistant"
            onClose={onClose}
            draft={{ code: 'return 1;', inputs: {} }}
            set={set}
            state={{ analysis: null, reading: false, failed: false }}
            stepLabel="Convert totals"
            automationId={null}
            stepId="s1"
            allowedTools={[]}
            upstreamFields={[]}
            {...overrides}
        />,
    );
    return { set, onClose };
}

afterEach(() => { cleanup(); assistCalls.length = 0; });

describe('the assistant in the large editor', () => {
    it('writes the new code into the draft, and Undo puts the old code back', async () => {
        const user = userEvent.setup();
        const { set } = editor();
        await user.type(screen.getByRole('textbox', { name: /ask bee/i }), 'Leave out small vendors{Enter}');
        await screen.findByText('Done: added a minimum.');
        expect(assistCalls).toEqual([{ code: 'return 1;', last: 'Leave out small vendors' }]);
        expect(set).toHaveBeenCalledWith('code', 'return 1;\n// minimum');
        expect(screen.getByText('Added a minimum')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect(set).toHaveBeenLastCalledWith('code', 'return 1;');
        expect(await screen.findByText(/back as it was/)).toBeTruthy();
    });

    it('offers starters when the code is empty', () => {
        editor({ draft: { code: '', inputs: {} } });
        expect(screen.getByRole('button', { name: /VAT/ })).toBeTruthy();
    });
});

describe('checks', () => {
    it('Fix with Bee takes the finding to the assistant, ready to send', async () => {
        const user = userEvent.setup();
        editor({ initialTab: 'checks', state: { analysis: BLOCKED, reading: false, failed: false } });
        expect(screen.getByText(/cannot run until this is fixed/)).toBeTruthy();
        expect(screen.getByText('Cannot run yet')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /Fix with Bee/ }));
        const box = await screen.findByRole('textbox', { name: /ask bee/i }) as HTMLTextAreaElement;
        await waitFor(() => expect(box.value).toMatch(/line 3/));
    });

    it('Escape closes the editor', async () => {
        const user = userEvent.setup();
        const { onClose } = editor();
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalled();
    });
});

describe('helpers', () => {
    it('cleanHostEntry reads what people paste', () => {
        expect(cleanHostEntry('https://API.example.com/v1/x?y=1')).toBe('api.example.com');
        expect(cleanHostEntry('*.example.com')).toBe('*.example.com');
        expect(cleanHostEntry('not a host')).toBeNull();
        expect(cleanHostEntry('localhost')).toBeNull();
    });

    it('Try it starts from the form and leaves blanks out, so defaults apply', () => {
        const params = [
            { name: 'amount', label: 'Amount', description: null, type: 'number', required: true, line: 1 },
            { name: 'rate', label: 'Rate', description: null, type: 'number', required: false, default: 21, line: 2 },
        ] as never;
        const values = tryValuesFrom(params, { amount: { kind: 'literal', value: 100 } }, ['note']);
        expect(values).toEqual({ amount: '100', rate: '21', note: '' });
        expect(inputsFromValues({ ...values, list: '[1,2]' })).toEqual({ amount: '100', rate: '21', list: [1, 2] });
    });

    it('the history sent to the assistant is text only, and skips a turn still streaming', () => {
        const turn = (id: number, over: Partial<AssistTurn> = {}): AssistTurn => ({ id, ask: `q${id}`, reply: `a${id}`, edits: [], status: 'done', error: null, before: null, after: null, decision: null, ...over });
        expect(historyOf([turn(1), turn(2, { status: 'streaming' }), turn(3, { reply: '' })])).toEqual([
            { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q3' },
        ]);
    });
});
