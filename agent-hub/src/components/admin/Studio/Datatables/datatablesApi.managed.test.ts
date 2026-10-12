import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { authFetch } from '../../../../utils/helpers';
import { datatablesApi } from './datatablesApi';
import { managedOf } from '../../../shared/managedPart';

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const REFUSAL = {
    error: 'This part is managed by a Solution stage. Change it in Dev and deploy.',
    code: 'managed_part',
    details: { solutionId: 's1', stage: 'prd' },
};

const fetchMock = vi.mocked(authFetch);

beforeEach(() => { fetchMock.mockReset(); });

describe('datatablesApi and a Solution stage', () => {
    it('a column save the stage refuses carries the banner info, apart from the column-conflict 409', async () => {
        fetchMock.mockResolvedValue(reply(REFUSAL, 409));
        const err = await datatablesApi.putSchema('t1', [], 3).catch((e: unknown) => e as any);
        expect(err.status).toBe(409);
        expect(err.code).toBe('managed_part');
        expect(err.message).toBe(REFUSAL.error);
        expect(err.managed).toMatchObject({ reason: 'managed', managed: { solutionId: 's1', stage: 'prd' } });
    });

    it('a row write on a reference table is the same refusal', async () => {
        fetchMock.mockResolvedValue(reply({ ...REFUSAL, details: { solutionId: 's1', stage: 'uat' } }, 409));
        const err = await datatablesApi.addRow('t1', { a: 1 }).catch((e: unknown) => e as any);
        expect(err.managed?.managed?.stage).toBe('uat');
    });

    it('the ordinary column conflict has no banner info', async () => {
        fetchMock.mockResolvedValue(reply({ error: 'Someone else changed the columns', code: 'model_conflict' }, 409));
        const err = await datatablesApi.putSchema('t1', [], 3).catch((e: unknown) => e as any);
        expect(err.status).toBe(409);
        expect(err.managed).toBeUndefined();
    });

    it('the GET payload keeps its `managed` where managedOf looks for it', async () => {
        const managed = { solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 7, devRef: null };
        fetchMock.mockResolvedValue(reply({ datatable: { id: 't1', managed } }));
        expect(managedOf(await datatablesApi.get('t1'))).toEqual(managed);
    });
});
