/**
 * Wat de chatkant VERSTUURT wanneer hij in testmodus staat (A4 deel A).
 *
 * De server kan nog zo netjes weigeren — als de client de vlag niet meestuurt
 * is er geen testchat, en als hij hem per ongeluk altijd meestuurt verdwijnt
 * elk gewoon gesprek uit de historie. Dat zijn de twee kanten die hier gepind
 * worden, plus de derde: een beslissing op de kaart is pas iets waard als hij
 * de VOLGENDE beurt daadwerkelijk meerijdt.
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
    // Een VERSE stream per aanroep: één gedeeld responseobject raakt na de
    // eerste beurt leeggelezen, en dan ziet de hook een stream zonder `done`
    // en blijft hij op "interrupted" staan — waarna een derde beurt niet eens
    // meer de deur uit gaat.
    authFetch.mockImplementation(async () => streamResponse(OK_STREAM));
});

describe('de testmodus op de agentchat', () => {
    it('BIJT — een gewone chat stuurt GEEN test-vlag mee', async () => {
        // Zou hij dat wel doen, dan wordt elk echt gesprek efemeer en
        // verdwijnt het uit de historie, de kaartvoet en de Used-by-tab.
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
        // Dit is het gat waarop de hele bevestigingskaart stond: de server
        // verbruikt een goedkeuring per request, maar bouwt zijn Map elke beurt
        // opnieuw uit de body. Bleef de client dezelfde verzameling meesturen,
        // dan kocht één klik op "Approve and run" élke latere beurt waarin het
        // model diezelfde call met dezelfde argumenten voorstelde — zonder
        // kaart, zonder klik.
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
        // Een efemere conversatie is `{ …, messages: [] }` en chatStream bouwt
        // de prompt daaruit. Zonder history begint elke testbeurt vanaf nul:
        // beurt 3 kan niet naar beurt 1 verwijzen, en een vastgehouden actie
        // wordt nooit opnieuw voorgesteld — dus wordt de goedkeuring nooit
        // verbruikt en beloven de knoppen een vervolg dat er niet is.
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
        // De server hasht die tot zijn efemere conversatie-id. Zonder sleutel
        // krijgt elke BEURT een eigen id en telt `COUNT(DISTINCT
        // conversation_id)` beurten: "6 testgesprekken" voor één gesprek van
        // zes berichten.
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
