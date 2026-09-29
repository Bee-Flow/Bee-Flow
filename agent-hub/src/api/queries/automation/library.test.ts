import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { authFetch } from '../../../utils/helpers';
import { duplicateAutomationOnServer, LibraryRequestError, parseTrash, restoreAutomation } from './library';

const fetchMock = vi.mocked(authFetch);
const json = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('automation library wire contract', () => {
    beforeEach(() => fetchMock.mockReset());

    it('parseTrash keeps well-formed rows and defaults the retention', () => {
        expect(parseTrash({ automations: [{ id: 'a', title: 'A', deletedAt: 'd', purgeAt: 'p' }, { title: 'no id' }, null] }))
            .toEqual({ automations: [{ id: 'a', title: 'A', deletedAt: 'd', purgeAt: 'p' }], retentionDays: 30 });
        expect(parseTrash('junk')).toEqual({ automations: [], retentionDays: 30 });
    });

    it('duplicates on the server and returns the new id from either shape', async () => {
        fetchMock.mockResolvedValueOnce(json({ automation: { id: 'copy1' } }));
        expect(await duplicateAutomationOnServer('src')).toBe('copy1');
        expect(fetchMock).toHaveBeenCalledWith('/api/automation/src/duplicate', { method: 'POST' });
        fetchMock.mockResolvedValueOnce(json({ id: 'copy2' }));
        expect(await duplicateAutomationOnServer('src')).toBe('copy2');
    });

    it('carries the status and the server sentence on a failure', async () => {
        fetchMock.mockResolvedValueOnce(json({ error: 'Not found' }, 404));
        const err = await duplicateAutomationOnServer('x').catch(e => e);
        expect(err).toBeInstanceOf(LibraryRequestError);
        expect(err.status).toBe(404);
        expect(err.message).toBe('Not found');
    });

    it('restores through POST /:id/restore', async () => {
        fetchMock.mockResolvedValueOnce(json({ automation: { id: 'r' } }));
        expect(await restoreAutomation('r')).toEqual({ id: 'r' });
        expect(fetchMock).toHaveBeenCalledWith('/api/automation/r/restore', { method: 'POST' });
    });
});
