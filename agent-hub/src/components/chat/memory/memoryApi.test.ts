import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../../api/client';
import { deleteMemory, fetchMemoriesByIds } from './memoryApi';

vi.mock('../../../api/client', () => ({ apiClient: { get: vi.fn(), delete: vi.fn(), put: vi.fn() } }));

beforeEach(() => { vi.mocked(apiClient.get).mockReset(); vi.mocked(apiClient.delete).mockReset(); });

describe('memoryApi', () => {
    it('Undo deletes with ?undo=1, an ordinary delete does not', async () => {
        await deleteMemory('a/b', { undo: true });
        expect(apiClient.delete).toHaveBeenLastCalledWith('/agents/memory/a%2Fb', { retry: false, query: { undo: '1' } });
        await deleteMemory('m1');
        expect(apiClient.delete).toHaveBeenLastCalledWith('/agents/memory/m1', { retry: false });
    });

    it('loads previews by comma-separated ids, at most 50, and skips the call for none', async () => {
        vi.mocked(apiClient.get).mockResolvedValue({ items: [{ id: 'm1' }] });
        expect(await fetchMemoriesByIds([])).toEqual([]);
        expect(apiClient.get).not.toHaveBeenCalled();
        const ids = Array.from({ length: 60 }, (_, i) => `m${i}`);
        expect(await fetchMemoriesByIds(ids)).toEqual([{ id: 'm1' }]);
        const query = (vi.mocked(apiClient.get).mock.calls[0][1] as { query: { ids: string } }).query;
        expect(query.ids.split(',')).toHaveLength(50);
    });
});
