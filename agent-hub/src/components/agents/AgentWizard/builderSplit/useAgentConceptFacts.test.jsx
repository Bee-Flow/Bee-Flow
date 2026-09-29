/**
 * useAgentConceptFacts — de conceptlezing achter de taalchip en de rolkaarten.
 *
 * De hele hook bestaat om de persona van het CONCEPT te halen, en dat kan
 * alleen met `?draft=1`: zonder die parameter antwoordt `GET /agents/:id` met
 * de runtime-projectie, en daar is de persona-kolom juist uit gestript.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/builderSplit/useAgentConceptFacts.test.jsx
 */
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const calls = [];
let handler = async () => ({ ok: true, json: async () => ({}) });

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url, opts = {}) => {
        calls.push(url);
        return handler(url, opts);
    }),
}));

import { READ } from '../canUse/canUseFacts';
import useAgentConceptFacts from './useAgentConceptFacts';

const PERSONA = { who: 'A colleague.', mode: 'fields', language: 'nl' };

beforeEach(() => {
    calls.length = 0;
    handler = async () => ({ ok: true, json: async () => ({ persona: PERSONA, unpublishedChanges: 3 }) });
});
afterEach(() => cleanup());

describe('useAgentConceptFacts', () => {
    it('vraagt de CONCEPTweergave op — zonder ?draft=1 komt er nooit een persona mee', async () => {
        const { result } = renderHook(() => useAgentConceptFacts('ag1'));
        await waitFor(() => expect(result.current.personaState).toBe(READ.OK));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('?draft=1');
        expect(result.current.persona).toEqual(PERSONA);
        expect(result.current.unpublishedChanges).toBe(3);
    });

    it('codeert het agent-id in het pad', async () => {
        renderHook(() => useAgentConceptFacts('ag/1'));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toBe('/agents/ag%2F1?draft=1');
    });

    it('meldt een antwoord ZONDER persona als onbekend, niet als lege rol', async () => {
        handler = async () => ({ ok: true, json: async () => ({ unpublishedChanges: 0 }) });
        const { result } = renderHook(() => useAgentConceptFacts('ag1'));
        await waitFor(() => expect(result.current.personaState).toBe(READ.ERROR));
        expect(result.current.persona).toBe(null);
    });

    it('meldt een mislukte lezing als onbekend', async () => {
        handler = async () => ({ ok: false, json: async () => ({}) });
        const { result } = renderHook(() => useAgentConceptFacts('ag1'));
        await waitFor(() => expect(result.current.personaState).toBe(READ.ERROR));
        expect(result.current.persona).toBe(null);
        expect(result.current.unpublishedChanges).toBe(null);
    });

    it('meldt een gooiende lezing als onbekend', async () => {
        handler = async () => { throw new Error('boom'); };
        const { result } = renderHook(() => useAgentConceptFacts('ag1'));
        await waitFor(() => expect(result.current.personaState).toBe(READ.ERROR));
        expect(result.current.persona).toBe(null);
    });

    it('geeft de feiten van een VORIGE agent niet door bij het wisselen', async () => {
        const { result, rerender } = renderHook(({ id }) => useAgentConceptFacts(id), {
            initialProps: { id: 'ag1' },
        });
        await waitFor(() => expect(result.current.persona).toEqual(PERSONA));
        rerender({ id: 'ag2' });
        expect(result.current.persona).toBe(null);
        expect(result.current.personaState).toBe(READ.LOADING);
    });
});
