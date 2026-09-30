/**
 * The project endpoints: every read through its allow-list — a null section
 * kept apart from an empty one — and every write to the path and with the
 * body the closed schemas in routes/projects/schemas.js accept.
 */

import { api } from '@/core/api/client';

import {
    changeMemberRole,
    createProject,
    deleteProject,
    fileResource,
    getProject,
    getProjectMembers,
    getProjectResources,
    listActivity,
    listDirectory,
    listProjects,
    listProjectThreads,
    removeMember,
    shareProject,
    updateProject,
} from './endpoints';

jest.mock('@/core/api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const del = api.delete as jest.Mock;

beforeEach(() => {
    jest.resetAllMocks();
});

describe('reads', () => {
    it('lists projects, keeping a known role and dropping an unknown one', async () => {
        get.mockResolvedValueOnce([
            { id: 'p1', name: 'Sales', ownerId: 'u1', version: 1, permission: 'owner', knowledgeBaseIds: ['kb1', 3], installedFromBlueprintId: 'bp', installedVersion: 2 },
            { id: 'p2', name: 'Ops', ownerId: 'u2', version: 1, permission: 'admin' },
            { name: 'no id' },
        ]);
        const projects = await listProjects();
        expect(projects).toHaveLength(2);
        expect(projects[0]).toMatchObject({ permission: 'owner', knowledgeBaseIds: ['kb1'], installedFromBlueprintId: 'bp', installedVersion: 2 });
        expect(projects[1]).toMatchObject({ permission: undefined, installedFromBlueprintId: null, installedVersion: null });
    });

    it('reads one project with its role, and nothing for a non-object', async () => {
        get.mockResolvedValueOnce({ id: 'p1', name: 'Sales', role: 'editor', shares: [{ id: 's', permission: 'owner-ish' }] });
        const detail = await getProject('p 1');
        expect(get).toHaveBeenCalledWith('/api/projects/p%201', expect.anything());
        expect(detail).toMatchObject({ role: 'editor', shares: [{ id: 's', permission: 'viewer' }] });
        get.mockResolvedValueOnce(null);
        expect(await getProject('p1')).toBeNull();
    });

    it('keeps "could not be read" (null) apart from "none" ([]) per section', async () => {
        get.mockResolvedValueOnce({
            role: 'owner',
            apps: [{ id: 'a1', name: 'Intake', userId: 'u1', secret: 'x' }],
            automations: [],
            datatables: null,
            knowledgeBases: [{ id: 'k1', name: 'Docs', description: 'Manuals' }],
            approvals: [{ id: 'q1', prompt: 'Approve?', status: 'pending' }],
        });
        const res = await getProjectResources('p1');
        expect(res?.apps).toEqual([{ id: 'a1', name: 'Intake', userId: 'u1', title: undefined, prompt: undefined, description: undefined, ownerId: undefined, ownerUserId: undefined, isActive: undefined, isDraft: undefined, isPublished: undefined, status: undefined }]);
        expect(res?.automations).toEqual([]);
        expect(res?.datatables).toBeNull();
        expect(res?.notebooks).toBeNull();
        expect(res?.approvals?.[0]).toMatchObject({ prompt: 'Approve?', status: 'pending' });
    });

    it('reads members, threads and a page of activity', async () => {
        get.mockResolvedValueOnce({ ownerId: 'u1', members: [{ id: 's1', sharedWithType: 'group', sharedWithId: 'g1', permission: 'editor' }] });
        expect((await getProjectMembers('p1'))?.members[0]).toMatchObject({ sharedWithType: 'group', permission: 'editor' });

        get.mockResolvedValueOnce({ threads: [{ id: 't1', title: 'Kick-off' }, { title: 'no id' }] });
        expect(await listProjectThreads('p1')).toHaveLength(1);
        expect(get).toHaveBeenLastCalledWith('/api/projects/p1/threads', expect.objectContaining({ query: { limit: 50 } }));

        get.mockResolvedValueOnce({ items: [{ id: 'e1', action: 'project_created', actorId: 'u1', details: 'nope' }, {}], hasMore: true });
        const page = await listActivity('p1', 30);
        expect(get).toHaveBeenLastCalledWith('/api/projects/p1/activity', expect.objectContaining({ query: { limit: 30, offset: 30 } }));
        expect(page.hasMore).toBe(true);
        expect(page.items).toEqual([
            { id: 'e1', action: 'project_created', actorId: 'u1', targetType: null, targetId: null, details: {}, createdAt: null },
        ]);
    });

    it('reads names best-effort: a refusal is an empty directory, not an error', async () => {
        get.mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce([{ id: 'g1', name: 'Finance' }]);
        expect(await listDirectory()).toEqual({ users: [], groups: [{ id: 'g1', name: 'Finance' }] });
    });
});

describe('writes', () => {
    const body = { name: 'Intake', description: null, customInstructions: null, icon: '📦', color: '#6366f1' };

    it('creates and updates with the project body, and reads the project back', async () => {
        post.mockResolvedValueOnce({ id: 'p9', name: 'Intake' });
        expect((await createProject(body)).id).toBe('p9');
        expect(post).toHaveBeenCalledWith('/api/projects', body);

        put.mockResolvedValueOnce({ id: 'p9', name: 'Renamed', version: 4 });
        expect((await updateProject('p9', { ...body, version: 3 })).version).toBe(4);
        expect(put).toHaveBeenCalledWith('/api/projects/p9', { ...body, version: 3 });
    });

    it('deletes, shares and manages members on their own paths', async () => {
        del.mockResolvedValue({ success: true });
        await deleteProject('p1');
        expect(del).toHaveBeenCalledWith('/api/projects/p1');

        post.mockResolvedValueOnce({ shareId: 's2', shares: [{ id: 's2', sharedWithType: 'user', sharedWithId: 'u2', permission: 'editor' }] });
        const shares = await shareProject('p1', { sharedWithType: 'user', sharedWithId: 'u2', permission: 'editor' });
        expect(post).toHaveBeenCalledWith('/api/projects/p1/share', { sharedWithType: 'user', sharedWithId: 'u2', permission: 'editor' });
        expect(shares[0]?.permission).toBe('editor');

        put.mockResolvedValue({ success: true });
        await changeMemberRole('p1', 's/2', 'viewer');
        expect(put).toHaveBeenCalledWith('/api/projects/p1/members/s%2F2', { role: 'viewer' });

        await removeMember('p1', 's2');
        expect(del).toHaveBeenCalledWith('/api/projects/p1/members/s2');
    });

    it('files a resource in or out with kind, id and attach', async () => {
        put.mockResolvedValue({ success: true });
        await fileResource('p1', { kind: 'knowledge_base', itemId: 'k1', attach: false });
        expect(put).toHaveBeenCalledWith('/api/projects/p1/resources', { kind: 'knowledge_base', id: 'k1', attach: false });
    });
});
