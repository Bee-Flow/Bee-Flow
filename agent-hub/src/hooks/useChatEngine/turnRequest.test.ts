// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { buildTurnRequest, toHistory, type TurnRequestInput } from './turnRequest';
import type { ChatMessage } from './types';

vi.mock('../../utils/helpers', () => ({ API_BASE: '/base' }));

const base = (extra: Partial<TurnRequestInput> = {}): TurnRequestInput => ({
    text: 'hi',
    attachments: [],
    isHidden: false,
    historyOverride: null,
    overrideTier: null,
    messages: [],
    isDirectMode: false,
    agentId: 'a1',
    chatProjectId: null,
    testChat: null,
    ...extra,
});

const convo: ChatMessage[] = [
    { id: '1', role: 'user', content: 'q', attachments: [{ name: 'f.pdf', type: 'application/pdf', content: 'BASE64', storageKey: 'k' }] },
    { id: '2', role: 'assistant', content: '  ' },
    { id: '3', role: 'tool', content: 'x' },
    { id: '4', role: 'assistant', content: 'a' },
];

describe('toHistory', () => {
    it('keeps user/assistant messages with text and strips attachments to the history shape', () => {
        expect(toHistory(convo)).toEqual([
            { role: 'user', content: 'q', attachments: [{ name: 'f.pdf', type: 'application/pdf', storageKey: 'k' }] },
            { role: 'assistant', content: 'a' },
        ]);
    });
});

describe('buildTurnRequest: agent chat', () => {
    it('posts to the agent endpoint without history for a persisted conversation', () => {
        const { url, payload } = buildTurnRequest(base({ conversationId: 'c1', messages: convo }));
        expect(url).toBe('/base/agents/a1/chat/stream');
        expect(payload).toMatchObject({ message: 'hi', agentId: 'a1', conversationId: 'c1', stream: true, isHidden: false });
        expect(payload).not.toHaveProperty('history');
        expect(payload).not.toHaveProperty('test');
    });

    it('sends the override history on edit/retry, and the tier when overridden', () => {
        const { payload } = buildTurnRequest(base({ historyOverride: convo, overrideTier: 'think' }));
        expect(payload.history).toEqual(toHistory(convo));
        expect(payload.modelTier).toBe('think');
    });

    it('sends the in-memory history and the test fields in a test chat', () => {
        const { payload } = buildTurnRequest(base({
            messages: convo,
            testChat: { asGroup: 'g1', sessionId: 'tc-123', toolDecisions: { k1: 'approve' } },
        }));
        expect(payload.history).toEqual(toHistory(convo));
        expect(payload).toMatchObject({
            test: true, testSessionId: 'tc-123', asGroup: 'g1',
            toolDecisions: [{ argsKey: 'k1', decision: 'approve' }],
        });
    });

    it('adds the chat-signals marker on a counted endpoint, never in a test chat', () => {
        const getChatSignalsPayload = vi.fn(() => ({ signalsNotice: 'v1' }));
        expect(buildTurnRequest(base({ getChatSignalsPayload })).payload.signalsNotice).toBe('v1');
        expect(getChatSignalsPayload).toHaveBeenCalledWith('agent');
        getChatSignalsPayload.mockClear();
        const test = buildTurnRequest(base({ getChatSignalsPayload, testChat: { sessionId: 's', toolDecisions: {} } }));
        expect(test.payload).not.toHaveProperty('signalsNotice');
        expect(getChatSignalsPayload).not.toHaveBeenCalled();
    });
});

describe('buildTurnRequest: direct chat', () => {
    it('posts to the direct endpoint with the current history for a new conversation', () => {
        const { url, payload } = buildTurnRequest(base({ isDirectMode: true, directMode: { modelTier: 'smart' }, messages: convo }));
        expect(url).toBe('/base/ai/chat/direct/stream');
        expect(payload).toMatchObject({ message: 'hi', modelTier: 'smart', history: toHistory(convo) });
    });

    it('sends no history for a persisted conversation, and honours a custom endpoint and extras', () => {
        const { url, payload } = buildTurnRequest(base({
            isDirectMode: true,
            conversationId: 'c1',
            chatProjectId: 'p1',
            activeSkillIds: ['s1'],
            directMode: { customEndpoint: '/webpages/x/chat', systemPrompt: 'sp', getExtraPayload: () => ({ extra: 1 }) },
        }));
        expect(url).toBe('/base/webpages/x/chat');
        expect(payload).not.toHaveProperty('history');
        expect(payload).toMatchObject({ modelTier: 'fast', systemPrompt: 'sp', extra: 1, projectId: 'p1', activeSkillIds: ['s1'] });
    });

    it('never sends the test fields on the direct path', () => {
        const { payload } = buildTurnRequest(base({ isDirectMode: true, testChat: { sessionId: 's', toolDecisions: { k: 'approve' } } }));
        expect(payload).not.toHaveProperty('test');
        expect(payload).not.toHaveProperty('toolDecisions');
    });
});

describe('buildTurnRequest: incognito', () => {
    const incognito = { sessionId: '7d3f0c1e-1111-4222-8333-944455556666' };

    it('direct: no conversation id, the whole history, incognito and memory off', () => {
        const { url, payload } = buildTurnRequest(base({ isDirectMode: true, conversationId: 'c1', messages: convo, incognito }));
        expect(url).toBe('/base/ai/chat/direct/stream');
        expect(payload).not.toHaveProperty('conversationId');
        expect(payload).not.toHaveProperty('testSessionId');
        expect(payload).toMatchObject({ incognito: true, history: toHistory(convo), memoryReadEnabled: false, memoryWriteEnabled: false });
    });

    it('direct: ignores the webpage endpoint and the side-panel payload', () => {
        const getNotebookPayload = vi.fn(() => ({ notebookspaceAvailable: true }));
        const { url, payload } = buildTurnRequest(base({
            isDirectMode: true, incognito, getNotebookPayload,
            directMode: { customEndpoint: '/ai/chat/webpage/stream' },
        }));
        expect(url).toBe('/base/ai/chat/direct/stream');
        expect(payload).not.toHaveProperty('notebookspaceAvailable');
        expect(getNotebookPayload).not.toHaveBeenCalled();
    });

    it('agent: the session id as testSessionId, the whole history, never the test fields', () => {
        const { url, payload } = buildTurnRequest(base({
            conversationId: 'c1', messages: convo, incognito,
            testChat: { sessionId: 'tc-1', toolDecisions: { k: 'approve' } },
        }));
        expect(url).toBe('/base/agents/a1/chat/stream');
        expect(payload).not.toHaveProperty('conversationId');
        expect(payload).not.toHaveProperty('test');
        expect(payload).not.toHaveProperty('toolDecisions');
        expect(payload).toMatchObject({
            incognito: true, testSessionId: incognito.sessionId, history: toHistory(convo),
            memoryReadEnabled: false, memoryWriteEnabled: false,
        });
    });

    it('still carries the chat-signals marker: usage counts apply to incognito too', () => {
        const getChatSignalsPayload = vi.fn(() => ({ signalsNotice: 'v1' }));
        expect(buildTurnRequest(base({ incognito, getChatSignalsPayload })).payload.signalsNotice).toBe('v1');
    });
});
