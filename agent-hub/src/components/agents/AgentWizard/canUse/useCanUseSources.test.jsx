/**
 * useCanUseSources — de twee extra lezingen van "Kan gebruiken" (A2 stap 2).
 *
 * Twee beloftes: er wordt niets gevraagd waar niets te vragen valt (anders
 * staat er een permanente waarschuwing over modules die de organisatie niet
 * heeft), en een lezing die mislukt terwijl er wél iets gegund is landt op
 * READ.ERROR — nooit op een stille lege lijst.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/canUse/useCanUseSources.test.jsx
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
import useCanUseSources from './useCanUseSources';

const TABLES = { datatables: [{ id: 't1', name: 'Quotes' }] };
const SUMMARY = { summary: { s1: { agents: 3 } } };

const okHandler = async (url) => {
    if (url.includes('/api/datatables')) return { ok: true, json: async () => TABLES };
    if (url.includes('/api/skills/usage-summary')) return { ok: true, json: async () => SUMMARY };
    return { ok: true, json: async () => ({}) };
};

beforeEach(() => { calls.length = 0; handler = okHandler; });
afterEach(() => cleanup());

describe('useCanUseSources — niets vragen waar niets te vragen valt', () => {
    it('vraagt geen tabellen op zonder grants, en noemt dat gelezen', async () => {
        const { result } = renderHook(() => useCanUseSources({ toolsConfig: null, attachedSkillIds: [] }));
        await waitFor(() => expect(result.current.tablesState).toBe(READ.OK));
        expect(result.current.tables).toEqual([]);
        expect(calls.some(u => u.includes('/api/datatables'))).toBe(false);
    });

    it('vraagt geen gebruikstelling op zonder gekoppelde skills', async () => {
        const { result } = renderHook(() => useCanUseSources({ toolsConfig: null, attachedSkillIds: [] }));
        await waitFor(() => expect(result.current.usageState).toBe(READ.OK));
        expect(result.current.usage).toEqual({});
        expect(calls.some(u => u.includes('usage-summary'))).toBe(false);
    });

    it('vraagt niets zolang de tab niet gebruikt wordt', async () => {
        renderHook(() => useCanUseSources({ enabled: false, toolsConfig: { datatables: { t1: {} } }, attachedSkillIds: ['s1'] }));
        await new Promise(r => setTimeout(r, 10));
        expect(calls).toEqual([]);
    });
});

describe('useCanUseSources — wél grants', () => {
    it('leest de tabellen en de gebruikstelling', async () => {
        const { result } = renderHook(() => useCanUseSources({
            toolsConfig: { datatables: { t1: { scope: 'own', columns: '*' } } },
            attachedSkillIds: ['s1'],
        }));
        await waitFor(() => expect(result.current.tablesState).toBe(READ.OK));
        await waitFor(() => expect(result.current.usageState).toBe(READ.OK));
        expect(result.current.tables).toEqual(TABLES.datatables);
        expect(result.current.usage).toEqual(SUMMARY.summary);
    });

    it('landt op READ.ERROR als de tabellenroute weigert (403 zonder automations-module)', async () => {
        handler = async (url) => {
            if (url.includes('/api/datatables')) return { ok: false, status: 403, json: async () => ({}) };
            return okHandler(url);
        };
        const { result } = renderHook(() => useCanUseSources({
            toolsConfig: { datatables: { t1: {} } }, attachedSkillIds: [],
        }));
        await waitFor(() => expect(result.current.tablesState).toBe(READ.ERROR));
        expect(result.current.tables).toBeNull();
    });

    it('landt op READ.ERROR als het antwoord geen lijst draagt', async () => {
        handler = async (url) => {
            if (url.includes('/api/datatables')) return { ok: true, json: async () => ({ datatables: 'nope' }) };
            return okHandler(url);
        };
        const { result } = renderHook(() => useCanUseSources({ toolsConfig: { datatables: { t1: {} } }, attachedSkillIds: [] }));
        await waitFor(() => expect(result.current.tablesState).toBe(READ.ERROR));
    });

    it('landt op READ.ERROR als de gebruikstelling weigert', async () => {
        handler = async (url) => {
            if (url.includes('usage-summary')) throw new Error('offline');
            return okHandler(url);
        };
        const { result } = renderHook(() => useCanUseSources({ toolsConfig: null, attachedSkillIds: ['s1'] }));
        await waitFor(() => expect(result.current.usageState).toBe(READ.ERROR));
        expect(result.current.usage).toBeNull();
    });

    it('leest de telling opnieuw zodra de OPGESLAGEN skill-lijst verandert', async () => {
        // De samenvatting telt de opgeslagen config. Vlak na het aanvinken zit
        // deze agent er nog niet in; als de opslag landt wel — en dan moet de
        // telling opnieuw gelezen worden, anders trekt de kaart er één af van
        // een getal dat deze agent nooit meetelde.
        const { result, rerender } = renderHook(
            ({ saved }) => useCanUseSources({ toolsConfig: null, attachedSkillIds: ['s1'], savedSkillIds: saved }),
            { initialProps: { saved: [] } },
        );
        await waitFor(() => expect(result.current.usageState).toBe(READ.OK));
        const before = calls.filter(u => u.includes('usage-summary')).length;

        rerender({ saved: ['s1'] });
        await waitFor(() => expect(calls.filter(u => u.includes('usage-summary')).length).toBe(before + 1));
    });

    it('probeert opnieuw op verzoek', async () => {
        handler = async (url) => {
            if (url.includes('/api/datatables')) return { ok: false, status: 500, json: async () => ({}) };
            return okHandler(url);
        };
        const { result } = renderHook(() => useCanUseSources({ toolsConfig: { datatables: { t1: {} } }, attachedSkillIds: [] }));
        await waitFor(() => expect(result.current.tablesState).toBe(READ.ERROR));
        const before = calls.filter(u => u.includes('/api/datatables')).length;

        handler = okHandler;
        result.current.refetchTables();
        await waitFor(() => expect(result.current.tablesState).toBe(READ.OK));
        expect(calls.filter(u => u.includes('/api/datatables')).length).toBe(before + 1);
    });
});
