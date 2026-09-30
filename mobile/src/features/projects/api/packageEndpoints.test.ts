/**
 * Blueprint packaging: the gallery is meta only, an upgrade is asked for by
 * id and never by manifest, a plan or an install that did not say so is not
 * one, and publishing reads only its three stamps.
 */

import { api } from '@/core/api/client';

import {
    applyUpgrade,
    exportSolution,
    getInstallCounts,
    installBlueprint,
    listBlueprints,
    listReleases,
    planUpgrade,
    publishSolution,
} from './packageEndpoints';

jest.mock('@/core/api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

beforeEach(() => jest.resetAllMocks());

it('lists the gallery, meta only and id-bearing rows only', async () => {
    get.mockResolvedValueOnce({ blueprints: [{ id: 'b1', name: 'Intake', version: 3, solutionKey: 'sol_p1', manifest: { huge: true } }, { name: 'x' }] });
    const list = await listBlueprints();
    expect(get).toHaveBeenCalledWith('/api/projects/package/blueprints', expect.anything());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'b1', version: 3, solutionKey: 'sol_p1', description: '' });
    expect(list[0]).not.toHaveProperty('manifest');
});

it('reads the history and the install count from their owner-only routes', async () => {
    get.mockResolvedValueOnce({ releases: [{ id: 'r1', version: 2, notes: null }] });
    expect((await listReleases('p1'))[0]?.notes.entities).toBeNull();
    expect(get).toHaveBeenLastCalledWith('/api/projects/p1/package/releases', expect.anything());

    get.mockResolvedValueOnce({ installsHere: 1, installsElsewhere: null });
    expect(await getInstallCounts('p1')).toEqual({ here: 1, elsewhere: null });
    expect(get).toHaveBeenLastCalledWith('/api/projects/p1/package/installs', expect.anything());
});

describe('upgrades', () => {
    it('asks for the plan by id, and refuses an answer that is not a plan', async () => {
        post.mockResolvedValueOnce({ ok: true, toVersion: 3, plan: { add: [{ ref: 'a', kind: 'app' }] }, manifest: {} });
        const plan = await planUpgrade('p1', 'bp1');
        expect(post).toHaveBeenCalledWith('/api/projects/p1/package/upgrade/plan', { blueprintId: 'bp1' });
        expect(plan.toVersion).toBe(3);
        expect(plan.rows.added).toEqual([{ ref: 'a', kind: 'app', name: 'a' }]);

        post.mockResolvedValueOnce({ ok: false });
        await expect(planUpgrade('p1', 'bp1')).rejects.toThrow();
    });

    it('applies by id and reads the report', async () => {
        post.mockResolvedValueOnce({ ok: true, report: { replaced: ['x'], added: { apps: [{}] } } });
        expect(await applyUpgrade('p1', 'bp1')).toEqual({ replaced: 1, added: 1, failed: [], warnings: [] });
        expect(post).toHaveBeenCalledWith('/api/projects/p1/package/upgrade', { blueprintId: 'bp1' }, expect.anything());
        post.mockResolvedValueOnce({ error: 'x' });
        await expect(applyUpgrade('p1', 'bp1')).rejects.toThrow();
    });
});

describe('install', () => {
    it('installs from the gallery with a trimmed name, and counts what arrived', async () => {
        post.mockResolvedValueOnce({
            projectId: 'p9',
            report: { installed: { apps: [{}, {}], automations: [{}] }, skipped: [{ ref: 'w', kind: 'webpage', why: 'Not on this plan.' }], warnings: ['Check it'] },
        });
        const report = await installBlueprint({ blueprintId: 'bp1' }, '  Mine ');
        expect(post).toHaveBeenCalledWith('/api/projects/package/install', { blueprintId: 'bp1', name: 'Mine' }, expect.anything());
        expect(report).toEqual({ projectId: 'p9', installed: 3, skipped: [{ ref: 'w', kind: 'webpage', why: 'Not on this plan.' }], warnings: ['Check it'] });
    });

    it('sends a file’s manifest without a blank name, and refuses a report with no Solution', async () => {
        post.mockResolvedValueOnce({ report: {} });
        await expect(installBlueprint({ manifest: { solution: {} } }, ' ')).rejects.toThrow();
        expect(post).toHaveBeenCalledWith('/api/projects/package/install', { manifest: { solution: {} } }, expect.anything());
    });
});

describe('publish and export', () => {
    it('publishes with save and reads only the stamps', async () => {
        post.mockResolvedValueOnce({ solution: { big: true }, _savedAs: 'bp2', _version: 4 });
        expect(await publishSolution('p1')).toEqual({ blueprintId: 'bp2', version: 4, saveError: null });
        expect(post).toHaveBeenCalledWith('/api/projects/p1/package/export', { save: true }, expect.anything());
        post.mockResolvedValueOnce({ _saveError: 'Too large' });
        expect((await publishSolution('p1')).saveError).toBe('Too large');
    });

    it('exports the file as text, and refuses a body that is not one', async () => {
        post.mockResolvedValueOnce({ solution: { name: 'X' } });
        expect(JSON.parse(await exportSolution('p1'))).toEqual({ solution: { name: 'X' } });
        post.mockResolvedValueOnce('nope');
        await expect(exportSolution('p1')).rejects.toThrow();
    });
});
