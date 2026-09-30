/**
 * The runtime, action bridge and data endpoints: draft flags ride as a query,
 * writes are never retried, and the batch's "route not there" answers become
 * `supported: false` instead of an empty screen.
 */

import { api, ApiError } from '@/core/api/client';

import { dataBatch, dataQuery, getRecord, listRecords, updateRecord } from './endpointsData';
import { getRuntime, pollRun, runAction, runStep } from './endpointsRuntime';
import { getSchema, listMembers, saveSchema } from './endpointsSchema';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const patch = api.patch as jest.Mock;

const refusal = (status: number, body: unknown) => new ApiError('refused', { status, body });

beforeEach(() => {
    for (const fn of [get, post, put, patch]) fn.mockReset();
});

describe('runtime and actions', () => {
    it('asks for the draft only when told to', async () => {
        get.mockResolvedValue({ id: 'a1', definition: { screens: [], actions: {} }, draft: true });
        await getRuntime('a1', { draft: true });
        expect(get).toHaveBeenLastCalledWith('/api/studio-apps/a1/runtime', { signal: undefined, query: { draft: 1 } });
        await getRuntime('a1');
        expect(get).toHaveBeenLastCalledWith('/api/studio-apps/a1/runtime', { signal: undefined, query: undefined });
    });

    it('runs an action once, waiting by default', async () => {
        post.mockResolvedValueOnce({ runId: 'r1', status: 'pending' });
        expect(await runAction('a1', 'act 1', { formValues: { email: 'x' } })).toMatchObject({ runId: 'r1', status: 'pending' });
        expect(post).toHaveBeenCalledWith(
            '/api/studio-apps/a1/actions/act%201/run',
            { formValues: { email: 'x' }, wait: true },
            expect.objectContaining({ retry: false, query: undefined }),
        );
    });

    it('sends a step with its scope roots and the draft query', async () => {
        post.mockResolvedValueOnce({ ok: true, result: { id: 'rec' } });
        const result = await runStep('a1', 'save', { stepIndex: 2, item: { n: 1 }, index: 0, draft: true });
        expect(result).toMatchObject({ ok: true, result: { id: 'rec' } });
        expect(post).toHaveBeenCalledWith(
            '/api/studio-apps/a1/actions/save/step',
            { stepIndex: 2, item: { n: 1 }, index: 0, formValues: {}, vars: {} },
            expect.objectContaining({ retry: false, query: { draft: 1 } }),
        );
    });

    it('polls a run by id', async () => {
        get.mockResolvedValueOnce({ runId: 'r1', status: 'completed', output: 3 });
        expect((await pollRun('a1', 'r1')).output).toBe(3);
        expect(get).toHaveBeenCalledWith('/api/studio-apps/a1/actions/runs/r1', { signal: undefined });
    });
});

describe('data', () => {
    it('batches reads and downgrades a missing route', async () => {
        post.mockResolvedValueOnce({ results: [{ id: 'b1', ok: true, data: {} }] });
        const reads = [{ id: 'b1', kind: 'records' as const, tableId: 't1' }];
        expect(await dataBatch('a1', reads)).toMatchObject({ supported: true });
        expect(post).toHaveBeenCalledWith('/api/studio-apps/a1/data/batch', { reads }, expect.objectContaining({ retry: {} }));

        post.mockRejectedValueOnce(refusal(404, { error: 'Not found' }));
        expect(await dataBatch('a1', reads)).toEqual({ supported: false });

        post.mockRejectedValueOnce(refusal(429, { error: 'slow down' }));
        await expect(dataBatch('a1', reads)).rejects.toMatchObject({ status: 429 });
    });

    it('queries a dataset with the refresh flag', async () => {
        post.mockResolvedValueOnce({ rows: [{ n: 1 }], result: [{ n: 1 }] });
        expect((await dataQuery('a1', { datasetId: 'd1' }, { refresh: true })).rows).toEqual([{ n: 1 }]);
        expect(post).toHaveBeenCalledWith('/api/studio-apps/a1/data/query', { datasetId: 'd1' }, expect.objectContaining({ query: { refresh: 1 } }));
    });

    it('JSON-encodes the list filter and sort', async () => {
        get.mockResolvedValueOnce({ records: [], nextCursor: null });
        await listRecords('a1', 't1', { filter: [{ field: 'x', op: 'eq', value: 1 }], limit: 20 });
        expect(get).toHaveBeenCalledWith('/api/studio-apps/a1/data/tables/t1/records', {
            signal: undefined,
            query: { filter: '[{"field":"x","op":"eq","value":1}]', sort: undefined, cursor: undefined, limit: 20, sample: undefined },
        });
    });

    it('reads a hidden record as null', async () => {
        get.mockRejectedValueOnce(refusal(404, { error: 'Record not found' }));
        expect(await getRecord('a1', 't1', 'r1')).toBeNull();
    });

    it('returns a record conflict with the current row, and throws a quota 409', async () => {
        patch.mockRejectedValueOnce(refusal(409, { code: 'record_conflict', record: { id: 'r1', name: 'theirs' } }));
        expect(await updateRecord('a1', 't1', 'r1', { values: { name: 'mine' }, expectedUpdatedAt: 't' })).toEqual({
            outcome: 'conflict', record: { id: 'r1', name: 'theirs' },
        });
        patch.mockRejectedValueOnce(refusal(409, { code: 'quota_exceeded' }));
        await expect(updateRecord('a1', 't1', 'r1', { values: {} })).rejects.toMatchObject({ status: 409 });
    });
});

describe('schema and members', () => {
    it('reads the schema and saves it with CAS', async () => {
        get.mockResolvedValueOnce({ model: null, modelVersion: 0 });
        expect(await getSchema('a1')).toEqual({ model: null, modelVersion: 0 });

        put.mockResolvedValueOnce({ success: true, version: 2 });
        expect(await saveSchema('a1', { tables: [] }, 1)).toEqual({ outcome: 'saved', version: 2 });
        expect(put).toHaveBeenCalledWith('/api/studio-apps/a1/schema', { model: { tables: [] }, expectedVersion: 1 }, { retry: false });

        put.mockRejectedValueOnce(refusal(409, { conflict: true, currentVersion: 3, model: { tables: [{ id: 't' }] } }));
        expect(await saveSchema('a1', {}, 1)).toEqual({ outcome: 'conflict', currentVersion: 3, model: { tables: [{ id: 't' }] } });

        put.mockRejectedValueOnce(refusal(422, { errors: ['table "x": bad rowFilter'] }));
        expect(await saveSchema('a1', {}, 1)).toEqual({ outcome: 'invalid', errors: ['table "x": bad rowFilter'] });
    });

    it('lists members', async () => {
        get.mockResolvedValueOnce({ members: [{ userId: 'u1', roleKey: 'member' }] });
        expect(await listMembers('a1')).toEqual([{ userId: 'u1', roleKey: 'member', createdAt: null }]);
    });
});
