/**
 * The management endpoints: the path and body each one sends, and — for the
 * autosave and publish — that the expected refusals (409, 422) come back as
 * values while everything else still throws.
 */

import { api, ApiError } from '@/core/api/client';

import { createApp, deleteApp, getApp, getCatalog, importApp, listMyApps, updateApp, upgradeTemplate } from './endpointsApps';
import { checkApp, listVersions, restoreVersion, saveDefinition } from './endpointsDefinition';
import { createPublicPage, deletePublicPage, listPublicPages, listPublishGroups, publishApp } from './endpointsPublish';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const patch = api.patch as jest.Mock;
const del = api.delete as jest.Mock;

const refusal = (status: number, body: unknown) => new ApiError('refused', { status, body });

beforeEach(() => {
    for (const fn of [get, post, put, patch, del]) fn.mockReset();
});

describe('apps', () => {
    it('reads the catalog and the owner list from their paths', async () => {
        get.mockResolvedValueOnce({ schemaVersion: 2 });
        expect((await getCatalog()).schemaVersion).toBe(2);
        expect(get).toHaveBeenLastCalledWith('/api/studio-apps/catalog', { signal: undefined });

        get.mockResolvedValueOnce({ apps: [{ id: 'a1', usage: { dbBytes: 1, dbRatio: 0 } }] });
        expect((await listMyApps())[0]?.usage).toEqual({ dbBytes: 1, dbRatio: 0 });
        expect(get).toHaveBeenLastCalledWith('/api/studio-apps/mine', { signal: undefined });
    });

    it('creates from a template and reports a failed data install', async () => {
        post.mockResolvedValueOnce({ success: true, app: { id: 'a2', name: 'CRM' }, dataInstall: { ok: false, error: 'seed' } });
        const created = await createApp({ templateId: 'crm' });
        expect(post).toHaveBeenCalledWith('/api/studio-apps', { templateId: 'crm' });
        expect(created.app.id).toBe('a2');
        expect(created.dataInstall).toEqual({ ok: false, error: 'seed', dataModelVersion: null });
    });

    it('imports an archive once, with the chosen name', async () => {
        post.mockResolvedValueOnce({ app: { id: 'a3' }, report: { installed: { rows: 3 } }, warnings: ['one file skipped'] });
        const result = await importApp({ format: 'beeflow.app' }, 'Copy');
        expect(post).toHaveBeenCalledWith(
            '/api/studio-apps/import',
            { envelope: { format: 'beeflow.app' }, name: 'Copy' },
            expect.objectContaining({ retry: false }),
        );
        expect(result.warnings).toEqual(['one file skipped']);
    });

    it('encodes the id and reads get/put/delete/upgrade', async () => {
        get.mockResolvedValueOnce({ app: { id: 'a/b' }, readOnly: false });
        expect((await getApp('a/b'))?.readOnly).toBe(false);
        expect(get).toHaveBeenLastCalledWith('/api/studio-apps/a%2Fb', { signal: undefined });

        put.mockResolvedValueOnce({ success: true, app: { id: 'a1', name: 'New' } });
        expect((await updateApp('a1', { name: 'New' })).name).toBe('New');
        expect(put).toHaveBeenCalledWith('/api/studio-apps/a1', { name: 'New' });

        del.mockResolvedValueOnce({ success: true });
        await deleteApp('a1');
        expect(del).toHaveBeenCalledWith('/api/studio-apps/a1');

        post.mockResolvedValueOnce({ ok: true, fromVersion: 1, toVersion: 2, version: 9 });
        expect(await upgradeTemplate('a1')).toEqual({ fromVersion: 1, toVersion: 2, version: 9, dataInstall: null });
    });
});

describe('saveDefinition', () => {
    const def = { screens: [], actions: {} };

    it('saves against the base version, never retrying', async () => {
        put.mockResolvedValueOnce({ success: true, version: 5, warnings: [], repairs: [{ code: 'id.rekeyed', path: 'screens[0]', message: 'm' }] });
        expect(await saveDefinition('a1', def, 4)).toEqual({
            outcome: 'saved', version: 5, warnings: [], repairs: [{ code: 'id.rekeyed', path: 'screens[0]', message: 'm' }],
        });
        expect(put).toHaveBeenCalledWith('/api/studio-apps/a1/definition', { definition: def, baseVersion: 4 }, { retry: false });
    });

    it('returns a 409 with the server copy to reconcile', async () => {
        put.mockRejectedValueOnce(refusal(409, { conflict: true, currentVersion: 6, definition: { screens: [{ id: 's' }] } }));
        expect(await saveDefinition('a1', def, 4)).toEqual({
            outcome: 'conflict', currentVersion: 6, definition: { screens: [{ id: 's' }] },
        });
    });

    it('returns a 422 with the issue list', async () => {
        put.mockRejectedValueOnce(refusal(422, { errors: [{ code: 'c', severity: 'error', path: 'p', message: 'm' }], warnings: [] }));
        const result = await saveDefinition('a1', def, 4);
        expect(result.outcome).toBe('invalid');
        expect(result.outcome === 'invalid' && result.errors[0]?.code).toBe('c');
    });

    it('still throws a 413 and a network failure', async () => {
        put.mockRejectedValueOnce(refusal(413, { error: 'too big' }));
        await expect(saveDefinition('a1', def, 4)).rejects.toMatchObject({ status: 413 });
        put.mockRejectedValueOnce(new Error('offline'));
        await expect(saveDefinition('a1', def, 4)).rejects.toThrow('offline');
    });
});

describe('check, versions', () => {
    it('posts the check options and reads the versions', async () => {
        post.mockResolvedValueOnce({ ok: true, static: { errors: [], warnings: [] } });
        expect((await checkApp('a1', { asRole: 'member' })).ok).toBe(true);
        expect(post).toHaveBeenCalledWith('/api/studio-apps/a1/check', { asRole: 'member' }, expect.any(Object));

        get.mockResolvedValueOnce({ versions: [{ id: 'v1' }] });
        expect(await listVersions('a1')).toHaveLength(1);

        post.mockResolvedValueOnce({ success: true, version: 8 });
        expect(await restoreVersion('a1', 'v1')).toEqual({ version: 8 });
        expect(post).toHaveBeenLastCalledWith('/api/studio-apps/a1/versions/v1/restore');
    });
});

describe('publishing', () => {
    it('publishes to groups and reads the answer', async () => {
        patch.mockResolvedValueOnce({ success: true, isPublished: true, sharedGroups: ['g1'], publishedVersion: 4 });
        expect(await publishApp('a1', { isPublished: true, sharedGroups: ['g1'] })).toEqual({
            outcome: 'published', isPublished: true, sharedGroups: ['g1'], publishedVersion: 4,
        });
        expect(patch).toHaveBeenCalledWith('/api/studio-apps/a1/publish', { isPublished: true, sharedGroups: ['g1'] }, { retry: false });
    });

    it('returns a 422 as the issues to fix, and throws a 400', async () => {
        patch.mockRejectedValueOnce(refusal(422, { errors: [{ code: 'x' }], warnings: [] }));
        expect(await publishApp('a1', { isPublished: true })).toMatchObject({ outcome: 'invalid', errors: [{ code: 'x' }] });
        patch.mockRejectedValueOnce(refusal(400, { error: 'Unknown group: g9' }));
        await expect(publishApp('a1', { isPublished: true, sharedGroups: ['g9'] })).rejects.toMatchObject({ status: 400 });
    });

    it('lists groups from the directory, without retrying a 403', async () => {
        get.mockResolvedValueOnce([{ id: 'g1', name: 'Sales' }]);
        expect(await listPublishGroups()).toEqual([{ id: 'g1', name: 'Sales', description: null, organizationId: null }]);
        expect(get).toHaveBeenCalledWith('/auth/groups', { signal: undefined, retry: false });
    });

    it('lists, mints and revokes public pages', async () => {
        get.mockResolvedValueOnce({ pages: [], publicAccess: null, blockers: [{ code: 'no_public_access', message: 'm' }] });
        expect((await listPublicPages('a1')).blockers).toHaveLength(1);

        post.mockResolvedValueOnce({ page: { token: 't1', url: 'u' }, blockers: [] });
        expect((await createPublicPage('a1')).page?.token).toBe('t1');
        expect(post).toHaveBeenCalledWith('/api/studio-apps/a1/public-pages', undefined, { retry: false });

        del.mockResolvedValueOnce({ success: true });
        await deletePublicPage('a1', 't1');
        expect(del).toHaveBeenCalledWith('/api/studio-apps/a1/public-pages/t1');
    });
});
