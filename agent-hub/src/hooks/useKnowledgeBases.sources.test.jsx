import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import useKnowledgeBases from './useKnowledgeBases';
import { knowledgeApi } from '../components/admin/Studio/KnowledgeStudio/knowledgeApi';

vi.mock('../components/admin/Studio/KnowledgeStudio/knowledgeApi', () => {
    const knowledgeApi = { listSources: vi.fn() };
    return { knowledgeApi, default: knowledgeApi };
});

vi.mock('../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
}));

/**
 * The sources half of the hook. What matters is that a sources failure stays
 * a SOURCES failure: the documents beside them are a different request, and
 * emptying both because one 500'd is how a knowledge base looks deleted.
 */

const SOURCES = {
    sources: [{ id: 's1', kind: 'upload', name: 'Uploaded files', documentCount: 3 }],
    totals: { sourceCount: 1, documentCount: 3, autoRefreshCount: 0 },
};

beforeEach(() => {
    vi.clearAllMocks();
    knowledgeApi.listSources.mockResolvedValue(SOURCES);
});

describe('useKnowledgeBases — sources', () => {
    it('loads a knowledge base’s sources and totals', async () => {
        const { result } = renderHook(() => useKnowledgeBases());
        await act(async () => { await result.current.fetchKBSources('kb1'); });
        expect(knowledgeApi.listSources).toHaveBeenCalledWith('kb1');
        expect(result.current.kbSources).toHaveLength(1);
        expect(result.current.kbSourceTotals).toEqual(SOURCES.totals);
        expect(result.current.kbSourcesError).toBeNull();
    });

    it('reports a sources failure without pretending there are none', async () => {
        knowledgeApi.listSources.mockRejectedValue(new Error('sources are down'));
        const { result } = renderHook(() => useKnowledgeBases());
        await act(async () => { await result.current.fetchKBSources('kb1'); });
        expect(result.current.kbSourcesError).toBe('sources are down');
        expect(result.current.kbSources).toEqual([]);
    });

    it('asks for nothing, and clears, when there is no knowledge base', async () => {
        const { result } = renderHook(() => useKnowledgeBases());
        await act(async () => { await result.current.fetchKBSources('kb1'); });
        await waitFor(() => expect(result.current.kbSources).toHaveLength(1));
        knowledgeApi.listSources.mockClear();
        await act(async () => { await result.current.fetchKBSources(null); });
        expect(knowledgeApi.listSources).not.toHaveBeenCalled();
        expect(result.current.kbSources).toEqual([]);
        expect(result.current.kbSourceTotals).toBeNull();
    });

    it('holds no source URL of its own — the transport is knowledgeApi', () => {
        // This hook exists BECAUSE /api/kb was copy-pasted into three
        // components. A hand-written `/sources` fetch here would repeat that
        // at the next layer down, and the copy would drift the first time a
        // query parameter changed. Read the source, since that is the only
        // place such a copy could appear.
        const src = fs.readFileSync(
            path.join(path.dirname(fileURLToPath(import.meta.url)), 'useKnowledgeBases.ts'),
            'utf8',
        );
        const own = [...src.matchAll(/`\$\{API_BASE\}([^`]*)`/g)].map(m => m[1]);
        expect(own.filter(u => u.includes('/sources'))).toEqual([]);
    });
});
