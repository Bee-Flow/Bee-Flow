/** Publish, public pages, the runtime payload and the action bridge through the allow-list. */

import {
    readActionRun,
    readCreatedPublicPage,
    readInvalid,
    readPublicPages,
    readPublished,
    readPublishGroups,
    readRuntime,
    readStep,
} from './readersRuntime';

describe('publishing', () => {
    it('reads the publish answer and a 422 body', () => {
        expect(readPublished({ success: true, isPublished: true, sharedGroups: [], publishedVersion: 5 })).toEqual({
            outcome: 'published',
            isPublished: true,
            sharedGroups: [],
            publishedVersion: 5,
        });
        const invalid = readInvalid({ error: 'Fix it', errors: [{ code: 'c', severity: 'error', path: 'p', message: 'm', hint: 'h' }] });
        expect(invalid.errors[0]).toEqual({ code: 'c', severity: 'error', path: 'p', message: 'm', hint: 'h' });
        expect(invalid.warnings).toEqual([]);
    });

    it('reads the groups array and drops id-less rows', () => {
        expect(readPublishGroups([{ id: 'g1', name: 'Sales', organizationId: 'o1', permissions: ['x'] }, { name: 'x' }])).toEqual([
            { id: 'g1', name: 'Sales', description: null, organizationId: 'o1' },
        ]);
        expect(readPublishGroups({ error: 'Forbidden' })).toEqual([]);
    });

    it('reads public pages with their blockers', () => {
        const state = readPublicPages({
            pages: [{ token: 't1', url: 'https://x/p/t1', createdAt: '2026-09-01', lastSeenAt: null, visits: '3' }, { url: 'x' }],
            publicAccess: { entryScreenId: 's1' },
            blockers: [{ code: 'not_published', message: 'Publish the app' }],
        });
        expect(state.pages).toEqual([{ token: 't1', url: 'https://x/p/t1', createdAt: '2026-09-01', lastSeenAt: null, visits: 3 }]);
        expect(state.publicAccess).toEqual({ entryScreenId: 's1' });
        expect(state.blockers).toHaveLength(1);
        expect(readCreatedPublicPage({ page: { token: 't2', url: 'u' }, blockers: [] }).page?.token).toBe('t2');
        expect(readCreatedPublicPage({}).page).toBeNull();
    });
});

describe('the run view', () => {
    it('reads the runtime payload and the viewer', () => {
        const runtime = readRuntime({
            id: 'a',
            name: 'Intake',
            definition: { screens: [{ id: 's' }], actions: {} },
            viewer: { id: 'u1', name: 'Ann', isOwner: true, roleKey: 'owner', secret: 'x' },
            draft: true,
            appVersion: 4,
        });
        expect(runtime.viewer).toEqual({ id: 'u1', name: 'Ann', email: null, isOwner: true, roleKey: 'owner' });
        expect(runtime.draft).toBe(true);
        expect(runtime.appVersion).toBe(4);
        expect(readRuntime(null).definition).toEqual({ screens: [], actions: {} });
        expect(readRuntime({ id: 'a' }).draft).toBe(false);
    });

    it('reads a finished run, a 202 and a skip', () => {
        expect(readActionRun({ runId: 'r1', status: 'completed', output: { n: 1 }, _appEffects: [{ kind: 'toast' }], error: null })).toEqual({
            runId: 'r1',
            status: 'completed',
            output: { n: 1 },
            _appEffects: [{ kind: 'toast' }],
            _appEffectsUnknown: false,
            error: null,
            message: null,
            approvalId: null,
        });
        expect(readActionRun({ runId: 'r2', status: 'pending' })).toMatchObject({ runId: 'r2', status: 'pending', output: undefined });
        expect(readActionRun({ status: 'skipped', message: 'Already running' })).toMatchObject({ runId: null, message: 'Already running' });
    });

    it('reads a step answer and a quota refusal', () => {
        expect(readStep({ ok: true, result: { id: 'rec1' } })).toEqual({
            ok: true, result: { id: 'rec1' }, error: null, code: null, limit: null, used: null,
        });
        expect(readStep({ ok: false, error: 'Quota', code: 'quota_exceeded', limit: 100, used: 100, result: null })).toMatchObject({
            ok: false, code: 'quota_exceeded', limit: 100, used: 100,
        });
    });
});
