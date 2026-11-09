/**
 * The Test tab: ask the saved draft a question, then turn that answer into a test.
 * The chat engine is the one boundary faked here; everything else is the real tab.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestTabPanel } from './BuilderTabPanels';
import type { TranslateParams } from '@/hooks/useTranslation';

let engine: Record<string, unknown>;
vi.mock('@/hooks/useChatEngine', () => ({ default: () => engine }));

const t = (key: string, fallback?: string, _params?: TranslateParams) => (typeof fallback === 'string' ? fallback : key);

const TURN = [
    { id: 'u1', role: 'user', content: 'What is the return policy?' },
    { id: 'a1', role: 'assistant', content: 'Thirty days.', toolHistory: [{ name: 'search_kb', status: 'done' }] },
];

function makeTestSet() {
    return {
        tests: [], testsState: 'ok', refetch: vi.fn(), loadRuns: vi.fn(), runTests: vi.fn(),
        runs: [], runsState: 'ok', runsUnknown: false, runsKeep: 0, lastRun: null, lastRunUnknown: false,
        readRefusal: null, progress: null, running: false, refusal: null,
        suggest: vi.fn(async () => ({
            suggestion: { expect: { mustMention: ['30 days'], toolsExpected: ['search_kb'] }, wrote: { mustMention: 'ai', toolsExpected: 'observed' } },
            refusal: null,
        })),
        createTest: vi.fn(async () => ({ test: { id: 't1' }, refusal: null })),
    };
}

function setup(over: { ro?: boolean; messages?: unknown[]; agent?: unknown } = {}) {
    engine = {
        messages: over.messages ?? TURN, isLoading: false, sendMessage: vi.fn(), stopGenerating: vi.fn(),
        toolDecisions: {}, decideTool: vi.fn(),
    };
    const testSet = makeTestSet();
    render(<TestTabPanel t={t} ro={!!over.ro} rel={null} agent={over.agent ?? { id: 'ag1', name: 'Helper' }} testSet={testSet} />);
    return testSet;
}

describe('TestTabPanel', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('turns the last answer into a test: propose, edit, save', async () => {
        const testSet = setup();
        await userEvent.click(screen.getByTestId('agent-tests-add-from-chat'));
        expect(testSet.suggest).toHaveBeenCalledWith({ question: 'What is the return policy?', answer: 'Thirty days.', toolsUsed: ['search_kb'] });
        const form = await screen.findByTestId('agent-tests-suggest-form');
        expect(form.getAttribute('data-state')).toBe('ready');
        expect(testSet.createTest).not.toHaveBeenCalled();

        await userEvent.click(screen.getByTestId('agent-tests-suggest-save'));
        await waitFor(() => expect(testSet.createTest).toHaveBeenCalledTimes(1));
        const saved = (testSet.createTest.mock.calls[0] as unknown[])[0] as { question: string; expect: { mustMention: string[] } };
        expect(saved.question).toBe('What is the return policy?');
        expect(saved.expect.mustMention).toEqual(['30 days']);
        await waitFor(() => expect(screen.queryByTestId('agent-tests-suggest-form')).toBeNull());
    });

    it('saves nothing when the form is cancelled', async () => {
        const testSet = setup();
        await userEvent.click(screen.getByTestId('agent-tests-add-from-chat'));
        await userEvent.click(await screen.findByTestId('agent-tests-suggest-cancel'));
        expect(screen.queryByTestId('agent-tests-suggest-form')).toBeNull();
        expect(testSet.createTest).not.toHaveBeenCalled();
    });

    it('shows the hint instead of the button before anything was asked', () => {
        setup({ messages: [] });
        expect(screen.queryByTestId('agent-tests-add-from-chat')).toBeNull();
        expect(screen.getByTestId('agent-tests-add-hint')).toBeTruthy();
    });

    it('offers neither the input nor the button when read-only', () => {
        setup({ ro: true });
        expect(screen.queryByTestId('agent-test-chat-input')).toBeNull();
        expect(screen.queryByTestId('agent-tests-add-from-chat')).toBeNull();
    });

    it('sends a typed question to the engine', async () => {
        setup({ messages: [] });
        await userEvent.type(screen.getByTestId('agent-test-chat-input'), 'Hi{Enter}');
        expect(engine.sendMessage).toHaveBeenCalledWith('Hi');
    });

    it('has no chat for an agent that is not saved yet', () => {
        setup({ agent: { name: 'New' } });
        expect(screen.queryByTestId('agent-test-chat')).toBeNull();
    });
});
