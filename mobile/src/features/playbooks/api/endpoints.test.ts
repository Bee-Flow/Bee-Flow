/**
 * The playbook endpoints: the paths and bodies each call sends, and the
 * allow-list every answer is read through — an unknown phase status never
 * offers a button, a body without a playbook is not a playbook, and the
 * composed recipe goes back to create exactly as the server wrote it.
 */

import { api } from '@/core/api/client';

import {
    assignAppMember,
    composeRecipe,
    createPlaybook,
    deletePlaybook,
    getAppAccess,
    getPlaybook,
    listPlaybooks,
    listTables,
    listTierModels,
    proposeAccess,
    publishApp,
    recheckCompliance,
    registerCompliance,
    sendWire,
} from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn(), delete: jest.fn() } };
});

const mocked = api as unknown as Record<'get' | 'post' | 'patch' | 'delete', jest.Mock>;

const PB = {
    id: 'pb_1',
    title: 'Contracts',
    status: 'active',
    recipeId: 'custom_x',
    options: { tier: 'fast' },
    version: 4,
    currentPhase: 'table',
    phases: [
        { key: 'table', kind: 'table', status: 'awaiting', attempt: 0, artifacts: { datatableName: 'Contracts' }, brief: null },
        { key: 'fill', status: 'teleported', artifacts: null },
        { status: 'ready' },
    ],
    secret: 'never read',
};

beforeEach(() => {
    for (const fn of Object.values(mocked)) fn.mockReset();
});

describe('reading', () => {
    it('lists the summaries and drops rows without an id', async () => {
        mocked.get.mockResolvedValue({ playbooks: [{ id: 'pb_1', title: 'A', status: 'done', progress: { done: 2, total: 2 }, phases: [] }, { title: 'no id' }] });
        const rows = await listPlaybooks();
        expect(mocked.get.mock.calls[0]?.[0]).toBe('/api/playbooks');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'pb_1', status: 'done', progress: { done: 2, total: 2, locked: 0 } });
    });

    it('reads one playbook through the allow-list', async () => {
        mocked.get.mockResolvedValue({ playbook: PB });
        const pb = await getPlaybook('pb 1');
        expect(mocked.get.mock.calls[0]?.[0]).toBe('/api/playbooks/pb%201');
        expect(pb.phases.map((p) => [p.key, p.status])).toEqual([['table', 'awaiting'], ['fill', 'pending']]);
        expect(pb.phases[1]?.artifacts).toEqual({});
        expect(pb).not.toHaveProperty('secret');
    });

    it('refuses a body without a playbook', async () => {
        mocked.get.mockResolvedValue({ error: 'x' });
        await expect(getPlaybook('pb_1')).rejects.toThrow('Could not load this playbook');
    });

    it('reads the tables, the tiers and where an app stands', async () => {
        mocked.get.mockImplementation((path: string) => {
            if (path === '/api/datatables') return Promise.resolve({ datatables: [{ id: 't1', name: 'Invoices', rowCount: '3' }] });
            if (path === '/ai/config/tiers-for-user') return Promise.resolve({ fast: { modelId: 'm1', label: 'x' }, auto: {} });
            if (path.endsWith('/members')) return Promise.resolve({ members: [{}, {}] });
            return Promise.resolve({ app: { id: 'a1', name: 'Tracker', isPublished: true, sharedGroups: ['g1', 7] } });
        });
        expect(await listTables()).toEqual([{ id: 't1', name: 'Invoices', rowCount: 3, managedKind: null }]);
        expect(await listTierModels()).toEqual({ fast: { modelId: 'm1' }, auto: { modelId: undefined } });
        expect(mocked.get.mock.calls[1]?.[1]).toMatchObject({ query: { taskType: 'automation' } });
        expect(await getAppAccess('a1')).toEqual({ app: { id: 'a1', name: 'Tracker', isPublished: true, sharedGroups: ['g1'] }, members: 2 });
    });
});

describe('writing', () => {
    it('composes, keeps the document whole, and creates from it', async () => {
        const doc = { title: 'T', description: 'D', table: { fields: [{ key: 'a', name: 'A', type: 'text' }] }, inputs: [{ key: 'folderPath', label: 'Folder', kind: 'folder', default: '/X' }], phases: [{ key: 'table', label: 'Table' }, { key: 'ok', requires: 'approvals' }], warnings: ['table_synthesized'] };
        mocked.post.mockResolvedValueOnce({ recipe: doc, warnings: ['w'] });
        const out = await composeRecipe('Read contracts', 'nl');
        expect(mocked.post.mock.calls[0]?.slice(0, 2)).toEqual(['/api/playbooks/recipes/compose', { description: 'Read contracts', locale: 'nl' }]);
        expect(out?.recipe).toMatchObject({ title: 'T', fields: [{ key: 'a' }], needsApprover: true, warnings: ['table_synthesized'], raw: doc });
        expect(out?.recipe.inputs[0]).toMatchObject({ key: 'folderPath', default: '/X' });
        mocked.post.mockResolvedValueOnce({ playbook: PB });
        expect((await createPlaybook({ recipe: doc }))?.id).toBe('pb_1');
        expect(mocked.post.mock.calls[1]?.[2]).toMatchObject({ retry: false });
    });

    it('sends a PATCH wire to the playbook and a POST wire to its phase route', async () => {
        mocked.patch.mockResolvedValue({ playbook: PB });
        mocked.post.mockResolvedValue({ playbook: PB });
        await sendWire('pb_1', { method: 'PATCH', body: { expectedVersion: 4, status: 'stopped' } });
        await sendWire('pb_1', { method: 'POST', route: 'phases/table/run' });
        expect(mocked.patch.mock.calls[0]?.slice(0, 2)).toEqual(['/api/playbooks/pb_1', { expectedVersion: 4, status: 'stopped' }]);
        expect(mocked.post.mock.calls[0]?.slice(0, 2)).toEqual(['/api/playbooks/pb_1/phases/table/run', {}]);
    });

    it('re-checks, proposes, registers and deletes on their own routes', async () => {
        mocked.post.mockImplementation((path: string) => {
            if (path.endsWith('/access-plan')) return Promise.resolve({ plan: { audience: { kind: 'groups', groupIds: ['g1'] }, members: [{ userId: 'u1' }], byGroup: { g1: 'x', g2: 3 }, unresolved: [{ kind: 'person', name: 'Zed' }], empty: false } });
            if (path.endsWith('/register')) return Promise.resolve({ playbook: PB, written: ['evidence'], failed: [{ what: 'risk:a', error: 'no' }] });
            return Promise.resolve({ playbook: PB });
        });
        await recheckCompliance('pb_1', 'compliance');
        expect(mocked.post.mock.calls[0]?.slice(0, 2)).toEqual(['/api/playbooks/pb_1/phases/compliance/run', { recheck: true }]);
        const plan = await proposeAccess('pb_1', 'access', 'Finance only');
        expect(plan).toMatchObject({ audience: { kind: 'groups', groupIds: ['g1'], groupNames: [] }, members: [{ userId: 'u1', roleKey: 'app', name: '' }], byGroup: { g1: 'x' }, unresolved: ['Zed'], empty: false });
        const reg = await registerCompliance('pb_1', 'compliance', { risks: [] });
        expect(reg).toMatchObject({ written: ['evidence'], failed: [{ what: 'risk:a', error: 'no' }] });
        await deletePlaybook('pb_1');
        expect(mocked.delete.mock.calls[0]?.[0]).toBe('/api/playbooks/pb_1');
    });

    it('applies access through the App Studio routes', async () => {
        await assignAppMember('a1', 'u1', 'viewer');
        await publishApp('a1', { isPublished: true, sharedGroups: [] });
        expect(mocked.post.mock.calls[0]?.slice(0, 2)).toEqual(['/api/studio-apps/a1/members', { userId: 'u1', roleKey: 'viewer' }]);
        expect(mocked.patch.mock.calls[0]?.slice(0, 2)).toEqual(['/api/studio-apps/a1/publish', { isPublished: true, sharedGroups: [] }]);
    });
});
