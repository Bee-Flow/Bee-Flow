/**
 * Every server call's path, method, body and options, against a mocked
 * client. The bodies matter as much as the paths: the server's schemas are
 * strict, so a key it does not read is a 400, not a silent default.
 */

import { api, ApiError } from '@/core/api/client';

import { builderTurnBody, getBuilderSession } from './builder';
import { agentPreviewQuery, getAgentPreview, getCatalog, getTableColumns } from './catalog';
import { createFlow, getFlowAutomation, isVersionChanged, publishFlow, saveFlow, setFlowActive } from './definition';
import { createFolder, deleteFolder, moveToFolder, updateFolder } from './folders';
import { createFormLink, createWebhook, deleteFormLink, deleteWebhook, listWebhooks, rotateFormLink, rotateWebhookSecret } from './links';
import { dryRun, runStep } from './runs';
import { createFromTemplate, exportFlow, importFlow, listTemplates } from './templates';
import { diffVersions, getVersion, listVersions, restoreVersion } from './versions';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return {
        ...actual,
        api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
    };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const del = api.delete as jest.Mock;

const DEF = { trigger: { id: 'trg', type: 'trigger' as const, kind: 'manual' }, steps: [], edges: [] };

beforeEach(() => {
    for (const fn of [get, post, put, del]) fn.mockReset();
});

describe('the automation', () => {
    it('loads, saves (PUT, only the patch) and creates (POST, never retried)', async () => {
        get.mockResolvedValue({ automation: { id: 'a 1', definition: DEF }, summary: '' });
        await getFlowAutomation('a 1');
        expect(get).toHaveBeenCalledWith('/api/automation/a%201', { signal: undefined });

        put.mockResolvedValue({ automation: { id: 'a1' }, warnings: [] });
        await saveFlow('a1', { definition: DEF });
        expect(put).toHaveBeenCalledWith('/api/automation/a1', { definition: DEF });

        post.mockResolvedValue({ automation: { id: 'new', definition: {} }, warnings: [{ message: 'Unfinished' }] });
        const created = await createFlow({ title: 'T', definition: DEF });
        expect(post).toHaveBeenCalledWith('/api/automation', { title: 'T', definition: DEF }, { retry: false });
        expect(created.automation?.definition).toEqual({ steps: [], edges: [] });
        expect(created.warnings).toEqual([{ severity: 'warning', message: 'Unfinished' }]);
    });

    it('arms and disarms without a body, and never retries', async () => {
        post.mockResolvedValue({ automation: { id: 'a1' }, warnings: [] });
        await setFlowActive('a1', true);
        await setFlowActive('a1', false);
        expect(post.mock.calls).toEqual([
            ['/api/automation/a1/activate', undefined, { retry: false }],
            ['/api/automation/a1/deactivate', undefined, { retry: false }],
        ]);
    });
});

describe('making the working copy live (handoff 5)', () => {
    it('sends the version on screen, or nothing without one, and never retries', async () => {
        post.mockResolvedValue({ automation: { id: 'a1', definition: {}, version: 5, liveVersion: 5, neverLive: false, pendingChanges: 0 }, warnings: ['Pinned sample'] });
        const out = await publishFlow('a 1', 5);
        expect(post).toHaveBeenLastCalledWith('/api/automation/a%201/publish', { version: 5 }, { retry: false });
        expect(out.automation).toMatchObject({ liveVersion: 5, pendingChanges: 0, definition: { steps: [], edges: [] } });
        expect(out.warnings).toEqual([{ severity: 'warning', message: 'Pinned sample' }]);
        await publishFlow('a1', null);
        expect(post).toHaveBeenLastCalledWith('/api/automation/a1/publish', {}, { retry: false });
    });

    it('tells an automation that moved on from every other refusal', () => {
        const moved = new ApiError('Version 5 is no longer the latest', { status: 409, body: { error: 'Version 5 is no longer the latest', code: 'version_changed', version: 6 } });
        const aiAct = new ApiError('Answer, then try again.', { status: 409, body: { error: 'Answer, then try again.', code: 'ai_act_check_required' } });
        expect(isVersionChanged(moved)).toBe(true);
        expect(isVersionChanged(aiAct)).toBe(false);
        expect(isVersionChanged(new ApiError('Invalid definition', { status: 400, body: { error: 'Invalid definition', details: [] } }))).toBe(false);
        expect(isVersionChanged(new Error('version_changed'))).toBe(false);
    });
});

describe('the automation row', () => {
    it('normalises the definition, so a stored {} is an empty graph', async () => {
        get.mockResolvedValueOnce({ automation: { id: 'a1', definition: {}, version: '3' }, summary: 'Does a thing' });
        const out = await getFlowAutomation('a1');
        expect(out?.automation.definition).toEqual({ steps: [], edges: [] });
        expect(out?.automation.version).toBe(3);
        expect(out?.summary).toBe('Does a thing');
        get.mockResolvedValueOnce({ automation: { id: 'a1', definition: 'x' } });
        expect((await getFlowAutomation('a1'))?.automation.definition).toEqual({ steps: [], edges: [] });
        get.mockResolvedValueOnce({ error: 'nope' });
        expect(await getFlowAutomation('a1')).toBeNull();
    });

    it('keeps a definition with extra keys as it is', async () => {
        const definition = { trigger: { id: 'trg', type: 'trigger' }, steps: [], edges: [], vars: { a: 1 }, schemaVersion: 1 };
        get.mockResolvedValueOnce({ automation: { id: 'a1', definition } });
        expect((await getFlowAutomation('a1'))?.automation.definition).toBe(definition);
    });

    it('reads a save’s findings and answers outcome, and its row in the editor’s shape', async () => {
        put.mockResolvedValueOnce({ automation: { id: 'a1', definition: {} }, warnings: ['Unfinished'], answers: { table: 't1' } });
        const out = await saveFlow('a1', { title: 'T' });
        expect(out).toMatchObject({ automation: { id: 'a1', definition: { steps: [], edges: [] } }, answers: { table: 't1' } });
        expect(out.warnings).toEqual([{ severity: 'warning', message: 'Unfinished' }]);
    });
});

describe('the catalog', () => {
    it('reads the catalog and a table’s columns', async () => {
        get.mockResolvedValueOnce({ apps: [] });
        await getCatalog();
        expect(get).toHaveBeenLastCalledWith('/api/automation/catalog', { signal: undefined });
        get.mockResolvedValueOnce({ columns: [{ id: 1, title: 'Name', type: 'text' }] });
        await expect(getTableColumns('Facturen')).resolves.toHaveLength(1);
        expect(get).toHaveBeenLastCalledWith('/api/automation/catalog/nextcloud-tables/Facturen/columns', { signal: undefined });
    });

    it('keeps "no tool list" and "an empty tool list" apart on the wire', async () => {
        expect(agentPreviewQuery({ useTools: true })).toEqual({ startAutomations: undefined, useKnowledge: undefined, useTools: '1', tools: undefined });
        expect(agentPreviewQuery({ useTools: false, tools: [] }).tools).toBe('');
        expect(agentPreviewQuery({ tools: ['a', 'b'] }).tools).toBe('a,b');
        get.mockResolvedValue({ id: 'ag', canUse: true });
        await getAgentPreview('ag 1', { tools: [] });
        expect(get).toHaveBeenCalledWith('/api/automation/catalog/agent/ag%201', expect.objectContaining({ query: expect.objectContaining({ tools: '' }) }));
    });
});

describe('versions', () => {
    it('lists, reads, diffs and restores', async () => {
        get.mockResolvedValue({});
        post.mockResolvedValue({ automation: null, restoredFromVersion: 2 });
        await listVersions('a1');
        await getVersion('a1', 'v1');
        await diffVersions('a1', 'v1', 'v2');
        await restoreVersion('a1', 'v1');
        expect(get.mock.calls.map((c) => c[0])).toEqual([
            '/api/automation/a1/versions',
            '/api/automation/a1/versions/v1',
            '/api/automation/a1/versions/v1/diff/v2',
        ]);
        expect(post).toHaveBeenCalledWith('/api/automation/a1/versions/v1/restore', undefined, { retry: false });
    });
});

describe('test runs', () => {
    it('sends the mode, and a trigger payload only when there is one', async () => {
        post.mockResolvedValue({ run: { id: 'r1' }, steps: [], stepRecord: null });
        await runStep('a1', 's 1', 'upTo');
        expect(post).toHaveBeenLastCalledWith('/api/automation/a1/steps/s%201/run', { mode: 'upTo' }, { timeoutMs: 180_000, retry: false });
        await runStep('a1', 's1', 'only', { triggerPayload: { a: 1 }, triggerStepId: 'wh' });
        expect(post.mock.lastCall?.[1]).toEqual({ mode: 'only', triggerPayload: { a: 1 }, triggerStepId: 'wh' });
        await dryRun('a1', { triggerPayload: null });
        expect(post).toHaveBeenLastCalledWith('/api/automation/a1/dry-run', {}, { timeoutMs: 180_000, retry: false });
    });
});

describe('templates, import and export', () => {
    it('installs a template by creating a draft from its definition', async () => {
        get.mockResolvedValueOnce({ template: { id: 't1', title: 'Invoice inbox', description: 'Mail to folder', definition: DEF } });
        post.mockResolvedValueOnce({ automation: { id: 'new' }, warnings: [] });
        const out = await createFromTemplate('t1');
        expect(get).toHaveBeenCalledWith('/api/automation/templates/t1', { signal: undefined });
        expect(post).toHaveBeenCalledWith(
            '/api/automation',
            { title: 'Invoice inbox', description: 'Mail to folder', definition: DEF },
            { retry: false },
        );
        expect(out?.automation?.id).toBe('new');
    });

    it('answers null for a template that is gone', async () => {
        get.mockResolvedValueOnce({});
        await expect(createFromTemplate('gone')).resolves.toBeNull();
        expect(post).not.toHaveBeenCalled();
    });

    it('lists templates, exports and imports', async () => {
        get.mockResolvedValue({});
        post.mockResolvedValue({ automation: { id: 'imp' }, warnings: ['Reconnect Gmail'] });
        await listTemplates();
        await exportFlow('a1');
        expect(get.mock.calls.map((c) => c[0])).toEqual(['/api/automation/templates', '/api/automation/a1/export']);
        const imported = await importFlow({ format: 'x', automation: {} });
        expect(post).toHaveBeenCalledWith('/api/automation/import', { format: 'x', automation: {} }, { retry: false });
        expect(imported.warnings[0]?.message).toBe('Reconnect Gmail');
    });
});

describe('webhooks and form links', () => {
    it('names the trigger only when asked to, and escapes the slug', async () => {
        post.mockResolvedValue({});
        del.mockResolvedValue({ success: true });
        get.mockResolvedValue({ webhooks: [] });
        await createWebhook('a1');
        await createWebhook('a1', 'wh2');
        await rotateWebhookSecret('a1', 'sl/ug');
        await expect(deleteWebhook('a1', 'slug')).resolves.toBe(true);
        await listWebhooks('a1');
        expect(post.mock.calls).toEqual([
            ['/api/automation/a1/webhook', {}, { retry: false }],
            ['/api/automation/a1/webhook', { triggerStepId: 'wh2' }, { retry: false }],
            ['/api/automation/a1/webhook/sl%2Fug/rotate', undefined, { retry: false }],
        ]);
        expect(del).toHaveBeenCalledWith('/api/automation/a1/webhook/slug', { retry: false });
        expect(get).toHaveBeenCalledWith('/api/automation/a1/webhooks', { signal: undefined });
    });

    it('creates, rotates and deletes a form link', async () => {
        post.mockResolvedValue({ form: { id: 'tok' }, url: 'https://x/f/tok' });
        del.mockResolvedValue({});
        await createFormLink('a1', 'trg');
        await rotateFormLink('a1', 'tok');
        await expect(deleteFormLink('a1', 'tok')).resolves.toBe(false);
        expect(post.mock.calls.map((c) => [c[0], c[1]])).toEqual([
            ['/api/automation/a1/form', { triggerStepId: 'trg' }],
            ['/api/automation/a1/form/tok/rotate', undefined],
        ]);
    });
});

describe('folders', () => {
    it('creates, renames, deletes and files into', async () => {
        post.mockResolvedValue({ folder: { id: 'f1', name: 'Sales' } });
        put.mockResolvedValue({ folder: { id: 'f1' } });
        del.mockResolvedValue({ detached: 2 });
        await createFolder({ name: 'Sales' });
        await updateFolder('f1', { name: 'Leads' });
        await expect(deleteFolder('f1')).resolves.toBe(2);
        put.mockResolvedValue({ automation: { id: 'a1' } });
        await moveToFolder('a1', null);
        expect(post).toHaveBeenCalledWith('/api/automation/folders', { name: 'Sales' }, { retry: false });
        expect(put.mock.calls).toEqual([
            ['/api/automation/folders/f1', { name: 'Leads' }],
            ['/api/automation/a1', { folderId: null }],
        ]);
    });
});

describe('the AI builder', () => {
    it('answers null for an automation with no session yet, and throws anything else', async () => {
        get.mockRejectedValueOnce(new ApiError('No builder session', { status: 404 }));
        await expect(getBuilderSession('a1')).resolves.toBeNull();
        get.mockRejectedValueOnce(new ApiError('Boom', { status: 500 }));
        await expect(getBuilderSession('a1')).rejects.toThrow('Boom');
        get.mockResolvedValueOnce({ snapshot: { sessionId: 'bs' } });
        await expect(getBuilderSession('a1')).resolves.toMatchObject({ sessionId: 'bs' });
        expect(get).toHaveBeenLastCalledWith('/api/automation/builder/session/a1', { signal: undefined });
    });

    it('sends exactly the keys the turn schema reads', () => {
        const body = builderTurnBody({ message: 'Build it', automationId: null, builderSessionId: null, history: [], timezone: 'Europe/Amsterdam' });
        expect(Object.keys(body).sort()).toEqual(
            ['attachments', 'automationId', 'builderSessionId', 'canvasScope', 'disabledMedia', 'history', 'message', 'modelTier', 'timezone', 'webSearchEnabled'],
        );
        expect(body).toMatchObject({ modelTier: 'auto', canvasScope: null, webSearchEnabled: true });
        expect(builderTurnBody({ message: 'x', automationId: 'a', builderSessionId: 'b', history: [], seedMetadata: { title: 'T' } }).seedMetadata).toEqual({ title: 'T' });
        expect(typeof builderTurnBody({ message: 'x', automationId: null, builderSessionId: null, history: [] }).timezone).toBe('string');
    });
});
