import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { authFetch } from '../../../../utils/helpers';
import { studioAppsApi } from './studioAppsApi';

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const REFUSAL = {
    error: 'This part is managed by a Solution stage. Change it in Dev and deploy.',
    code: 'managed_part',
    details: { solutionId: 's1', stage: 'prd' },
};
const MANAGED = { solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 3, devRef: null };

const fetchMock = vi.mocked(authFetch);

beforeEach(() => { fetchMock.mockReset(); });

describe('studioAppsApi and a Solution stage', () => {
    it('getApp carries the `managed` the route sends beside the row onto the row', async () => {
        fetchMock.mockResolvedValue(reply({ app: { id: 'a1', name: 'Quotes' }, readOnly: false, managed: MANAGED }));
        const res: any = await studioAppsApi.getApp('a1');
        expect(res.app).toEqual({ id: 'a1', name: 'Quotes', managed: MANAGED });
    });

    it('getApp leaves an answer without the field alone', async () => {
        fetchMock.mockResolvedValue(reply({ app: { id: 'a1' } }));
        expect((await studioAppsApi.getApp('a1')).app).toEqual({ id: 'a1' });
    });

    it('a 409 managed_part on an autosave is its own outcome, not a version conflict', async () => {
        fetchMock.mockResolvedValue(reply(REFUSAL, 409));
        const res: any = await studioAppsApi.saveDefinition('a1', { screens: [] }, 4);
        expect(res.ok).toBe(false);
        expect(res.conflict).toBeUndefined();
        expect(res.error).toBe(REFUSAL.error);
        expect(res.managed).toMatchObject({ reason: 'managed', managed: { solutionId: 's1', stage: 'prd' } });
    });

    it('the same for the data model save', async () => {
        fetchMock.mockResolvedValue(reply(REFUSAL, 409));
        const res: any = await studioAppsApi.saveSchema('a1', { tables: [] }, 2);
        expect(res.conflict).toBeUndefined();
        expect(res.managed?.reason).toBe('managed');
    });

    it('a real version conflict is still a conflict', async () => {
        fetchMock.mockResolvedValue(reply({ error: 'Version changed', code: 'version_conflict', currentVersion: 9 }, 409));
        const res: any = await studioAppsApi.saveDefinition('a1', { screens: [] }, 4);
        expect(res).toMatchObject({ ok: false, conflict: true, currentVersion: 9 });
        expect(res.managed).toBeUndefined();
    });

    it('every other call throws an error that carries the banner info', async () => {
        fetchMock.mockResolvedValue(reply(REFUSAL, 409));
        const err = await studioAppsApi.restoreVersion('a1', 'v1').catch((e: unknown) => e as any);
        expect(err.status).toBe(409);
        expect(err.code).toBe('managed_part');
        expect(err.managed.managed.solutionId).toBe('s1');
    });
});
