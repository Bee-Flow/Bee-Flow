/**
 * Create, delete and "used by": the bodies and paths, the tolerant reading of
 * validator findings, and the usage answer that must never read as "used
 * nowhere" when the server could not say.
 */

import { api, ApiError } from '@/core/api/client';

import { issueDetailsOf, readIssues } from './issues';
import { createAutomation, deleteAutomation, getAutomationUsage, readUsage } from './lifecycle';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const del = api.delete as jest.Mock;

beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockReset();
});

describe('findings', () => {
    it('reads validator records, partial records and bare sentences, and drops the rest', () => {
        expect(
            readIssues(
                [
                    { code: 'graph.cycle', severity: 'error', path: 'edges', message: 'A cycle', hint: 'Remove an edge' },
                    { severity: 'loud', message: 'Odd severity' },
                    { error: 'Only an error field' },
                    '   ',
                    null,
                    ['nested'],
                ],
                'warning',
            ),
        ).toEqual([
            { code: 'graph.cycle', severity: 'error', path: 'edges', message: 'A cycle', hint: 'Remove an edge' },
            { severity: 'warning', message: 'Odd severity' },
            { severity: 'warning', message: 'Only an error field' },
        ]);
        expect(readIssues('not a list', 'error')).toEqual([]);
    });

    it('reads a refusal’s details as errors, and nothing from anything else', () => {
        const refusal = new ApiError('Invalid definition', { status: 400, body: { error: 'Invalid definition', details: [{ path: 'steps.s1', message: 'Bad' }] } });
        expect(issueDetailsOf(refusal)).toEqual([{ severity: 'error', path: 'steps.s1', message: 'Bad' }]);
        expect(issueDetailsOf(new Error('offline'))).toEqual([]);
        expect(issueDetailsOf(new ApiError('HTTP 500', { status: 500 }))).toEqual([]);
    });
});

describe('create and delete', () => {
    it('creates with the body as given, never retried, and reads the warnings', async () => {
        post.mockResolvedValue({ automation: { id: 'a1', title: 'T' }, warnings: [{ code: 'kb.missing', message: 'Pick a base' }] });
        const out = await createAutomation({ title: 'T', definition: { steps: [], edges: [] } });
        expect(post).toHaveBeenCalledWith('/api/automation', { title: 'T', definition: { steps: [], edges: [] } }, { retry: false });
        expect(out.automation?.id).toBe('a1');
        expect(out.warnings).toEqual([{ code: 'kb.missing', severity: 'warning', message: 'Pick a base' }]);
    });

    it('deletes by id and reads the outcome', async () => {
        del.mockResolvedValue({ success: true });
        await expect(deleteAutomation('a 1')).resolves.toBe(true);
        expect(del).toHaveBeenCalledWith('/api/automation/a%201', { retry: false });
        del.mockResolvedValue(null);
        await expect(deleteAutomation('a1')).resolves.toBe(false);
    });
});

describe('usage', () => {
    it('reads the rows, and `complete` only when the server says true', async () => {
        get.mockResolvedValue({
            usage: [{ automationId: 'a1', consumerKind: 'app', consumerId: 'app1', consumerTitle: 'CRM', label: 'Send', canOpen: true }],
            complete: true,
        });
        const out = await getAutomationUsage('a1');
        expect(get).toHaveBeenCalledWith('/api/automation/a1/usage', { signal: undefined });
        expect(out.complete).toBe(true);
        expect(out.usage[0]).toMatchObject({ consumerTitle: 'CRM', canOpen: true, wired: true, screenId: null });
        expect(readUsage({ usage: [], complete: 'yes' }).complete).toBe(false);
        expect(readUsage(null)).toEqual({ usage: [], complete: false });
    });

    it('throws when the server could not check, rather than answering "used nowhere"', async () => {
        get.mockRejectedValue(new ApiError('usage_unavailable', { status: 500, body: { error: 'usage_unavailable' } }));
        await expect(getAutomationUsage('a1')).rejects.toBeInstanceOf(ApiError);
    });
});
