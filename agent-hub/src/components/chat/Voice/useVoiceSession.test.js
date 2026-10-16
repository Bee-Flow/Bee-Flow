import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useVoiceSession from './useVoiceSession';
import { authFetch } from '../../../utils/helpers';
import { installVoiceStubs, removeVoiceStubs, speakOneTurn } from './voiceTestKit';

// The hook's only network seam.
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

// Browser stubs and the VAD helpers live in voiceTestKit.ts.

const sseResponse = () => ({
    ok: true,
    body: {
        getReader: () => {
            let sent = false;
            return {
                read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return {
                        done: false,
                        value: new TextEncoder().encode('event: done\ndata: {}\n\n'),
                    };
                },
            };
        },
    },
});

const SESSION = {
    model: 'claude-sonnet-4-5',
    systemPrompt: 'You are the Finance agent.',
    agentId: 'agent-42',
    voice: 'nl-nova',
    agentName: 'Finance',
};

/** Captured FormData of the last POST /ai/voice/turn. */
let lastTurnForm = null;

beforeEach(() => {
    lastTurnForm = null;
    installVoiceStubs();
    authFetch.mockReset();
    authFetch.mockImplementation(async (url, opts) => {
        if (String(url).endsWith('/ai/voice/session')) {
            return { ok: true, json: async () => SESSION };
        }
        if (String(url).endsWith('/ai/voice/turn')) {
            lastTurnForm = opts.body;
            return sseResponse();
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
});

afterEach(removeVoiceStubs);

describe('useVoiceSession', () => {
    it('connect() stores the resolved session', async () => {
        const { result } = renderHook(() => useVoiceSession({ getHistory: () => [] }));
        await act(async () => { await result.current.connect({ agentId: 'agent-42' }); });
        expect(result.current.session).toEqual(SESSION);
    });

    // Regression: finishRecording/vadTick/connect are all memoized on stable
    // deps, so they are created once on the FIRST render. Reading `session`
    // out of the render scope inside submitTurn therefore pinned every
    // VAD-driven turn to render 1's `session === null`, and the agent's
    // systemPrompt/model/agentId silently never reached POST /ai/voice/turn —
    // every voice turn ran the server's DEFAULT_SYSTEM_PROMPT and
    // DEFAULT_LLM_MODEL with the user's full (unrestricted) tool set.
    it('sends the agent prompt/model/agentId from the connected session on a VAD-driven turn', async () => {
        const { result } = renderHook(() => useVoiceSession({ getHistory: () => [] }));
        await speakOneTurn(result);

        expect(lastTurnForm).toBeInstanceOf(FormData);
        expect(lastTurnForm.get('systemPrompt')).toBe(SESSION.systemPrompt);
        expect(lastTurnForm.get('model')).toBe(SESSION.model);
        expect(lastTurnForm.get('agentId')).toBe(SESSION.agentId);
        expect(lastTurnForm.get('voice')).toBe(SESSION.voice);
        expect(lastTurnForm.get('audio')).toBeTruthy();
    });

    // The hook drops hidden, streaming, non-string and null history entries.
    it('filters hidden, streaming, non-string and null host history entries out of the turn', async () => {
        const getHistory = () => [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hidden', isHidden: true },
            { role: 'assistant', content: 'streaming', isStreaming: true },
            { role: 'assistant', content: 42 },
            null,
        ];
        const { result } = renderHook(() => useVoiceSession({ getHistory }));
        await speakOneTurn(result);
        expect(JSON.parse(lastTurnForm.get('history'))).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('hangup() clears the session so a later turn cannot resurrect it', async () => {
        const { result } = renderHook(() => useVoiceSession({ getHistory: () => [] }));
        await act(async () => { await result.current.connect({ agentId: 'agent-42' }); });
        act(() => { result.current.hangup(); });
        expect(result.current.session).toBeNull();
    });
});
