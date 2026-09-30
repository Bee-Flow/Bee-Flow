/**
 * The summary-template calls: the paths, the `.strict()` bodies the route
 * accepts, and what a slightly wrong payload reads as.
 */

import { api } from '@/core/api/client';

import {
    createSummaryTemplate,
    deleteSummaryTemplate,
    listSummaryTemplates,
    listOrgTemplates,
    updateSummaryTemplate,
} from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const patch = api.patch as jest.Mock;
const del = api.delete as jest.Mock;

const DRAFT = { name: ' Board ', prompt: ' Sections ', scope: 'user' as const, groupId: 'g1', isDefault: true };

beforeEach(() => jest.clearAllMocks());

describe('listSummaryTemplates', () => {
    it('reads built-ins, custom rows and the admin flag, with defaults', async () => {
        get.mockResolvedValue({
            builtins: [{ id: 'general', name: 'General meeting', nameKey: 'meeting_notes.tpl_general', prompt: 'P' }],
            custom: [{ id: 't1', name: 'Mine', scope: 'org', isDefault: true, groupId: null, version: 2 }],
            defaultTemplateId: 't1',
            canManageOrg: true,
            primaryOrgId: 'o1',
        });
        const out = await listSummaryTemplates();
        expect(get).toHaveBeenCalledWith('/api/summary-templates', { signal: undefined, retry: false });
        expect(out.canManageOrg).toBe(true);
        expect(out.defaultTemplateId).toBe('t1');
        expect(out.builtins[0]).toMatchObject({ id: 'general', nameKey: 'meeting_notes.tpl_general' });
        expect(out.custom[0]).toMatchObject({ id: 't1', scope: 'org', isDefault: true, groupId: null });
    });

    it('reads a non-object as nothing', async () => {
        get.mockResolvedValue('oops');
        expect(await listSummaryTemplates()).toEqual({
            builtins: [],
            custom: [],
            defaultTemplateId: null,
            canManageOrg: false,
        });
    });
});

describe('listOrgTemplates', () => {
    it('reads the templates and groups of GET /org and drops id-less rows', async () => {
        get.mockResolvedValue({
            orgId: 'o1',
            templates: [{ id: 'o-1', name: 'Org style', scope: 'org', groupId: null }, { name: 'x' }],
            groups: [{ id: 'g1', name: 'Sales' }, { name: 'x' }],
        });
        const out = await listOrgTemplates();
        expect(out.groups).toEqual([{ id: 'g1', name: 'Sales' }]);
        expect(out.templates.map((tpl) => tpl.id)).toEqual(['o-1']);
        expect(get.mock.calls[0][0]).toBe('/api/summary-templates/org');
    });
});

describe('writes', () => {
    it('creates with trimmed fields and no groupId outside a group scope', async () => {
        post.mockResolvedValue({ id: 'n1', name: 'Board' });
        await createSummaryTemplate(DRAFT);
        expect(post).toHaveBeenCalledWith('/api/summary-templates', {
            scope: 'user',
            name: 'Board',
            prompt: 'Sections',
            isDefault: true,
        });
    });

    it('sends groupId with a group template', async () => {
        post.mockResolvedValue({});
        await createSummaryTemplate({ ...DRAFT, scope: 'group' });
        expect(post.mock.calls[0][1]).toMatchObject({ scope: 'group', groupId: 'g1' });
    });

    it('patches only name, prompt and isDefault', async () => {
        patch.mockResolvedValue({ id: 't 1' });
        await updateSummaryTemplate('t 1', { ...DRAFT, scope: 'org' });
        expect(patch).toHaveBeenCalledWith('/api/summary-templates/t%201', {
            name: 'Board',
            prompt: 'Sections',
            isDefault: true,
        });
    });

    it('deletes by id', async () => {
        del.mockResolvedValue({ ok: true });
        await deleteSummaryTemplate('t1');
        expect(del).toHaveBeenCalledWith('/api/summary-templates/t1');
    });
});
