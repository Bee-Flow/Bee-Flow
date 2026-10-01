import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import useSkillOutputs, { leadSkillIds } from './useSkillOutputs';

const fetchCatalogSkill = vi.hoisted(() => vi.fn());
vi.mock('../../../../api/queries/automation/agents', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchCatalogSkill,
}));

const DEFINITION = {
    steps: [
        { id: 'a', type: 'ai_step', skillIds: ['sk1', 'sk2'] },
        { id: 'b', type: 'ai_step', skillIds: [] },
        { id: 'c', type: 'code', skillIds: ['nope'] },
        { id: 'lp', type: 'loop', body: [{ id: 'd', type: 'ai_step', skillIds: ['sk3'] }] },
    ],
};

describe('leadSkillIds', () => {
    it('takes the first own skill of every AI step, loop bodies included', () => {
        expect(leadSkillIds(DEFINITION)).toEqual(['sk1', 'sk3']);
        expect(leadSkillIds(null)).toEqual([]);
    });
});

describe('useSkillOutputs', () => {
    it('fetches nothing without a query client', () => {
        const { result } = renderHook(() => useSkillOutputs(DEFINITION));
        expect(result.current).toBeNull();
        expect(fetchCatalogSkill).not.toHaveBeenCalled();
    });

    it('maps each leading skill to its declared output fields', async () => {
        fetchCatalogSkill.mockImplementation(async (id: string) => ({
            id, name: id, version: 1, outputFields: id === 'sk1' ? [{ key: 'summary', type: 'string', title: null }] : [],
        }));
        const client = new QueryClient();
        const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
        const { result } = renderHook(() => useSkillOutputs(DEFINITION), { wrapper });
        await waitFor(() => expect(result.current).toEqual({ sk1: { outputFields: [{ key: 'summary', type: 'string', title: null }] } }));
    });
});
