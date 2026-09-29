/**
 * useToolCatalog — de twee lezingen achter de Tools-kaart.
 *
 * Eén ervan is de leen-vraag, en die stelde de kaart aan de verkeerde persoon.
 * `GET /api/integrations/connections/grants` filtert onvoorwaardelijk op de
 * INGELOGDE gebruiker (routes/integrations/connections.js: `grantorUserId:
 * userId`), terwijl de runtime leent van `agent.owner_id`
 * (toolPolicy.resolveLentProviders). Bij een gedeelde of org-agent — een agent
 * die iemand anders bezit en die jij als org-genoot met `manage_agents` mag
 * bewerken — zijn dat twee verschillende mensen, en bood het scherm dus een
 * keuze aan die de runtime anders uitvoerde.
 *
 * Daarom vraagt deze hook het aan de server, per agent, en krijgt hij precies
 * één ding terug: voor welke apps lenen kan. Niet welke verbinding er hangt.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/canUse/useToolCatalog.test.jsx
 */
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calls = [];
let handler = async () => ({ ok: true, json: async () => ({}) });

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url, opts = {}) => {
        calls.push(url);
        return handler(url, opts);
    }),
}));

import { READ } from './canUseFacts';
import useToolCatalog from './useToolCatalog';

const CATALOG = {
    apps: [{ id: 'gmail', label: 'Gmail', provider: 'google', actions: [], actionsKnown: true, available: true }],
    degraded: false,
    providersKnown: true,
    lendingEnabled: true,
};

const okHandler = async (url) => {
    if (url.includes('/agents/tool-catalog')) return { ok: true, json: async () => CATALOG };
    if (url.includes('/tool-lending')) return { ok: true, json: async () => ({ apps: ['gmail'], readable: true }) };
    return { ok: true, json: async () => ({}) };
};

beforeEach(() => { calls.length = 0; handler = okHandler; });
afterEach(() => cleanup());

describe('useToolCatalog — de leen-vraag gaat over de eigenaar', () => {
    it('vraagt het per agent aan de server, niet aan de grants van de ingelogde bewerker', async () => {
        const { result } = renderHook(() => useToolCatalog({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.lentState).toBe(READ.OK));

        expect(calls.some(u => u.includes('/agents/a1/tool-lending'))).toBe(true);
        expect(calls.some(u => u.includes('/integrations/connections/grants'))).toBe(false);
        expect(result.current.lentApps).toEqual(new Set(['gmail']));
    });

    it('leest het antwoord als een JA/NEE PER APP', async () => {
        handler = async (url) => {
            if (url.includes('/tool-lending')) {
                return { ok: true, json: async () => ({ apps: ['gmail', 'google-drive'], readable: true }) };
            }
            return okHandler(url);
        };
        const { result } = renderHook(() => useToolCatalog({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.lentState).toBe(READ.OK));
        expect(result.current.lentApps).toEqual(new Set(['gmail', 'google-drive']));
    });
});

describe('useToolCatalog — onbekend versmalt', () => {
    it('`readable: false` is null (niet leeg) en landt op READ.ERROR', async () => {
        handler = async (url) => {
            if (url.includes('/tool-lending')) return { ok: true, json: async () => ({ apps: [], readable: false }) };
            return okHandler(url);
        };
        const { result } = renderHook(() => useToolCatalog({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.lentState).toBe(READ.ERROR));
        expect(result.current.lentApps).toBe(null);
    });

    it('een weigering (403 — deze agent mag je niet bewerken) is geen lege lijst', async () => {
        handler = async (url) => {
            if (url.includes('/tool-lending')) return { ok: false, status: 403, json: async () => ({}) };
            return okHandler(url);
        };
        const { result } = renderHook(() => useToolCatalog({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.lentState).toBe(READ.ERROR));
        expect(result.current.lentApps).toBe(null);
    });

    it('een antwoord zonder lijst is onleesbaar, niet leeg', async () => {
        handler = async (url) => {
            if (url.includes('/tool-lending')) return { ok: true, json: async () => ({ readable: true }) };
            return okHandler(url);
        };
        const { result } = renderHook(() => useToolCatalog({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.lentState).toBe(READ.ERROR));
        expect(result.current.lentApps).toBe(null);
    });

    it('zonder agent-id valt er niets te lenen — dat is een gelezen nul, geen lezing', async () => {
        const { result } = renderHook(() => useToolCatalog({ agentId: null }));
        await waitFor(() => expect(result.current.lentState).toBe(READ.OK));
        expect(result.current.lentApps).toEqual(new Set());
        expect(calls.some(u => u.includes('tool-lending'))).toBe(false);
    });

    it('draagt `runtimeCurated` over — en onbekend blijft null', async () => {
        handler = async (url) => {
            if (url.includes('/agents/tool-catalog')) return { ok: true, json: async () => CATALOG };
            if (url.includes('/tool-lending')) {
                return { ok: true, json: async () => ({ apps: ['gmail'], readable: true, runtimeCurated: true }) };
            }
            return { ok: true, json: async () => ({}) };
        };
        const { result } = renderHook(() => useToolCatalog({ agentId: 'a1' }));
        await waitFor(() => expect(result.current.lentState).toBe(READ.OK));
        expect(result.current.runtimeCurated).toBe(true);

        cleanup();
        // Een oude server (of een antwoord zonder het veld) is ONBEKEND, geen
        // "niet gecureerd": de kaart hoort er dan niets over te zeggen.
        handler = okHandler;
        const second = renderHook(() => useToolCatalog({ agentId: 'a1' }));
        await waitFor(() => expect(second.result.current.lentState).toBe(READ.OK));
        expect(second.result.current.runtimeCurated).toBe(null);
    });

    it('een HERLEZING versmalt: de vorige leenlijst is het antwoord over een andere agent', async () => {
        // Wisselt de bewerker binnen hetzelfde scherm van agent, dan rekende de
        // kaart tijdens de lopende fetch met de leenlijst van de EIGENAAR VAN DE
        // VORIGE AGENT — en stond de eigenaar-schakelaar open op grond van
        // andermans lening.
        let release;
        handler = async (url) => {
            if (url.includes('/agents/tool-catalog')) return { ok: true, json: async () => CATALOG };
            if (url.includes('/a1/tool-lending')) {
                return { ok: true, json: async () => ({ apps: ['gmail'], readable: true, runtimeCurated: true }) };
            }
            if (url.includes('/a2/tool-lending')) {
                await new Promise((r) => { release = r; });
                return { ok: true, json: async () => ({ apps: [], readable: true, runtimeCurated: false }) };
            }
            return { ok: true, json: async () => ({}) };
        };
        const { result, rerender } = renderHook(
            ({ agentId }) => useToolCatalog({ agentId }),
            { initialProps: { agentId: 'a1' } },
        );
        await waitFor(() => expect(result.current.lentApps).toEqual(new Set(['gmail'])));

        rerender({ agentId: 'a2' });
        await waitFor(() => expect(result.current.lentState).toBe(READ.LOADING));
        expect(result.current.lentApps).toBe(null);
        expect(result.current.runtimeCurated).toBe(null);

        release?.();
        await waitFor(() => expect(result.current.lentState).toBe(READ.OK));
        expect(result.current.lentApps).toEqual(new Set());
    });

    it('vraagt niets zolang de tab niet gebruikt wordt', async () => {
        renderHook(() => useToolCatalog({ enabled: false, agentId: 'a1' }));
        await new Promise(r => setTimeout(r, 10));
        expect(calls).toEqual([]);
    });
});
