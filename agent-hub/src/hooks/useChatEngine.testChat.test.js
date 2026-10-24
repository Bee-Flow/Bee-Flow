/**
 * What the chat side SENDS when it is in test mode (A4 part A).
 *
 * The server can refuse as neatly as it likes. If the client does not send the flag,
 * there is no test chat, and if it accidentally always sends it, every ordinary
 * conversation disappears from the history. Those are the two sides pinned here,
 * plus a third: a decision on the card is only worth something if it is actually
 * carried along with the NEXT turn.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useChatEngine from './useChatEngine';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
    generateMessageId: () => Math.random().toString(36).slice(2),
    getSessionToken: () => null,
    setSessionToken: () => {},
    isNextcloudEmbed: () => false,
}));

vi.mock('./useTranslation', () => ({
    default: () => ({ t: (k) => k }),
    useTranslation: () => ({ t: (k) => k }),
}));

const streamResponse = (chunks) => {
    const encoded = chunks.map((c) => new TextEncoder().encode(c));
    let i = 0;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: () => (i < encoded.length
                    ? Promise.resolve({ done: false, value: encoded[i++] })
                    : Promise.resolve({ done: true, value: undefined })),
                cancel: () => Promise.resolve(),
            }),
        },
    };
};

const OK_STREAM = [
    'event: content\ndata: {"text":"Hi."}\n\n',
    'event: done\ndata: {"conversationId":"c1"}\n\n',
];

const AGENT = { id: 'a1', name: 'Agent' };

const setup = (extra = {}) => renderHook((props) => useChatEngine({
    selectedAgent: AGENT,
    currentConversation: null,
    directMode: { enabled: false },
    ...extra,
    ...(props || {}),
}));

const bodyOf = (nth = 0) => JSON.parse(authFetch.mock.calls[nth][1].body);

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    // A FRESH stream per call. One shared response object is read empty after the
    // first turn, and then the hook sees a stream without `done` and stays on
    // "interrupted". After that, a third turn does not even go out the door.
    authFetch.mockImplementation(async () => streamResponse(OK_STREAM));
});

describe('de testmodus op de agentchat', () => {
    it('BIJT — een gewone chat stuurt GEEN test-vlag mee', async () => {
        // If it did so, every real conversation would become ephemeral and would disappear
        // from the history, the card footer and the Used-by tab.
        const { result } = setup();
        await act(async () => { await result.current.sendMessage('hoi'); });
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        const body = bodyOf();
        expect(body.test).toBeUndefined();
        expect(body.asGroup).toBeUndefined();
        expect(body.toolDecisions).toBeUndefined();
    });

    it('een testchat stuurt test:true, en "Test als" rijdt in dezelfde body mee', async () => {
        const { result } = setup({ testChat: { enabled: true, asGroup: 'sales' } });
        await act(async () => { await result.current.sendMessage('hoi'); });
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        const body = bodyOf();
        expect(body.test).toBe(true);
        expect(body.asGroup).toBe('sales');
        expect(authFetch.mock.calls[0][0]).toContain('/agents/a1/chat/stream');
    });

    it('zonder groep gaat er geen asGroup mee', async () => {
        const { result } = setup({ testChat: { enabled: true } });
        await act(async () => { await result.current.sendMessage('hoi'); });
        expect(bodyOf().asGroup).toBeUndefined();
    });

    it('BIJT — een beslissing rijdt mee op de VOLGENDE beurt', async () => {
        const { result } = setup({ testChat: { enabled: true } });
        await act(async () => { await result.current.sendMessage('hoi'); });
        expect(bodyOf(0).toolDecisions).toBeUndefined();

        act(() => { result.current.decideTool('a'.repeat(32), 'approve'); });
        await act(async () => { await result.current.sendMessage('en nu?'); });

        expect(bodyOf(1).toolDecisions).toEqual([{ argsKey: 'a'.repeat(32), decision: 'approve' }]);
    });

    it('de eerste beslissing over een actie wint — een tweede klik is geen nieuwe toestemming', async () => {
        const { result } = setup({ testChat: { enabled: true } });
        act(() => { result.current.decideTool('b'.repeat(32), 'decline'); });
        act(() => { result.current.decideTool('b'.repeat(32), 'approve'); });
        expect(result.current.toolDecisions).toEqual({ ['b'.repeat(32)]: 'decline' });
    });

    it('onzin wordt niet als beslissing aangenomen', async () => {
        const { result } = setup({ testChat: { enabled: true } });
        act(() => {
            result.current.decideTool('', 'approve');
            result.current.decideTool('c'.repeat(32), 'maybe');
            result.current.decideTool(null, 'decline');
        });
        expect(result.current.toolDecisions).toEqual({});
    });
});

describe('BIJT — één ja draait één actie', () => {
    const KEY = 'a'.repeat(32);

    it('een beslissing rijdt ÉÉN keer mee, niet elke volgende beurt', async () => {
        // This is the gap on which the whole confirmation card stood. The server consumes
        // an approval per request, but builds its Map afresh each turn from the body. If
        // the client kept sending the same collection along, one click on "Approve and
        // run" would buy every later turn in which the model proposed that same call with
        // the same arguments. Without a card, without a click.
        const { result } = setup({ testChat: { enabled: true } });
        await act(async () => { await result.current.sendMessage('beurt 1'); });

        act(() => { result.current.decideTool(KEY, 'approve', { callId: 'call_1' }); });
        await act(async () => { await result.current.sendMessage('beurt 2'); });
        expect(bodyOf(1).toolDecisions).toEqual([{ argsKey: KEY, decision: 'approve' }]);

        await act(async () => { await result.current.sendMessage('beurt 3'); });
        await act(async () => { await result.current.sendMessage('beurt 4'); });
        expect(bodyOf(2).toolDecisions).toBeUndefined();
        expect(bodyOf(3).toolDecisions).toBeUndefined();
    });

    it('de aantekening op de kaart BLIJFT wel staan, op de kaart waarop geklikt is', async () => {
        const { result } = setup({ testChat: { enabled: true } });
        act(() => { result.current.decideTool(KEY, 'approve', { callId: 'call_1' }); });
        await act(async () => { await result.current.sendMessage('beurt 2'); });
        expect(result.current.toolDecisions).toEqual({ call_1: 'approve' });
    });

    it('een nieuwe kaart voor dezelfde actie is een nieuwe vraag', async () => {
        // Op argsKey boekhouden liet een "nee" van vijf beurten geleden de
        // knoppen weghalen bij een verse kaart voor dezelfde actie.
        const { result } = setup({ testChat: { enabled: true } });
        act(() => { result.current.decideTool(KEY, 'decline', { callId: 'call_1' }); });
        await act(async () => { await result.current.sendMessage('beurt 2'); });

        act(() => { result.current.decideTool(KEY, 'approve', { callId: 'call_9' }); });
        expect(result.current.toolDecisions).toEqual({ call_1: 'decline', call_9: 'approve' });
        await act(async () => { await result.current.sendMessage('beurt 3'); });
        expect(bodyOf(1).toolDecisions).toEqual([{ argsKey: KEY, decision: 'approve' }]);
    });
});

describe('BIJT — een testchat heeft geheugen', () => {
    it('stuurt de beurten van dit gesprek mee, want de server bewaart er geen', async () => {
        // An ephemeral conversation is `{ …, messages: [] }`, and chatStream builds the
        // prompt from that. Without history every test turn starts from zero. Turn 3
        // cannot refer to turn 1, and a held action is never proposed again, so the
        // approval is never consumed and the buttons promise a follow-up that does not
        // exist.
        const { result } = setup({ testChat: { enabled: true } });
        await act(async () => { await result.current.sendMessage('wat zijn de openingstijden?'); });
        await act(async () => { await result.current.sendMessage('en op zaterdag?'); });

        const second = bodyOf(1);
        expect(Array.isArray(second.history)).toBe(true);
        expect(second.history.map(m => m.role)).toEqual(['user', 'assistant']);
        expect(second.history[0].content).toBe('wat zijn de openingstijden?');
    });

    it('een gewone chat stuurt nog steeds GEEN history — die leest de server zelf', async () => {
        const { result } = setup();
        await act(async () => { await result.current.sendMessage('hoi'); });
        await act(async () => { await result.current.sendMessage('nog eens'); });
        expect(bodyOf(1).history).toBeUndefined();
    });
});

describe('BIJT — één testgesprek is één gesprek', () => {
    it('elke beurt draagt dezelfde sessiesleutel', async () => {
        // The server hashes that into its ephemeral conversation id. Without a key every
        // TURN gets its own id, and `COUNT(DISTINCT conversation_id)` counts turns: "6
        // test conversations" for one conversation of six messages.
        const { result } = setup({ testChat: { enabled: true } });
        await act(async () => { await result.current.sendMessage('een'); });
        await act(async () => { await result.current.sendMessage('twee'); });
        const a = bodyOf(0).testSessionId;
        const b = bodyOf(1).testSessionId;
        expect(typeof a).toBe('string');
        expect(a.length).toBeGreaterThanOrEqual(8);
        expect(b).toBe(a);
    });

    it('een gewone chat draagt er geen', async () => {
        const { result } = setup();
        await act(async () => { await result.current.sendMessage('hoi'); });
        expect(bodyOf(0).testSessionId).toBeUndefined();
    });
});
