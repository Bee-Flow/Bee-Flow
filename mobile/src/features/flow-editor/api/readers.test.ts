/**
 * The flow editor's payloads through their readers. The ways a server answer
 * goes wrong without an error — a renamed field, a null where a list was, a
 * row with no id, a bare string where an object was — each become a stated
 * default. The catalog additionally keeps every field it does not name.
 */

import { readBuilderSnapshot } from './builder';
import { readCatalog, readPickSources } from './catalogReader';
import {
    readFolderDeleted,
    readFolderList,
    readFormLinkList,
    readFormLinkResponse,
    readWebhookList,
    readWebhookResponse,
} from './linkReaders';
import { readExport, readSaveResult, readStepRun } from './readers';
import { readAgentPreview, readTemplateList, readTemplateResponse } from './templateReaders';
import { readVersionDiff, readVersionList, readVersionResponse } from './versionReaders';

describe('save results', () => {
    it('reads the row, the findings (strings included) and the answers outcome', () => {
        const out = readSaveResult({
            automation: { id: 'a1', definition: { steps: [], edges: [] } },
            warnings: [
                { code: 'input.missing', severity: 'warning', path: 'steps[s1].inputs.to', message: 'Missing', hint: 'Fill it', blockedAt: 'activate' },
                { path: 'steps.s2.approval.assignee', message: 'Not in your organisation' },
                'Removed the saved manual-trigger sample payload',
                { code: 'only.code' },
                42,
                {},
            ],
            answers: { datatableId: 't1', created: true },
        });
        expect(out.automation?.id).toBe('a1');
        expect(out.warnings).toEqual([
            { code: 'input.missing', severity: 'warning', path: 'steps[s1].inputs.to', message: 'Missing', hint: 'Fill it', blockedAt: 'activate' },
            { severity: 'warning', path: 'steps.s2.approval.assignee', message: 'Not in your organisation' },
            { severity: 'warning', message: 'Removed the saved manual-trigger sample payload' },
            { severity: 'warning', code: 'only.code', message: 'only.code' },
        ]);
        expect(out.answers).toEqual({ datatableId: 't1', created: true });
        expect(readSaveResult(null)).toEqual({ automation: null, warnings: [], answers: null });
    });

    it('reads a step run: the run, the rows with ids, and the asked-for row', () => {
        const out = readStepRun({
            run: { id: 'r1', status: 'success' },
            steps: [{ stepId: 's1', status: 'success', output: { a: 1 } }, { status: 'x' }],
            stepRecord: { stepId: 's1', status: 'success' },
        });
        expect(out.run?.id).toBe('r1');
        expect(out.steps.map((s) => s.stepId)).toEqual(['s1']);
        expect(out.stepRecord?.stepId).toBe('s1');
        expect(readStepRun({}).stepRecord).toBeNull();
    });

    it('reads an export envelope and its sentences', () => {
        expect(readExport({ envelope: { format: 'beeflow-automation' }, warnings: ['Removed x', 3] })).toEqual({
            envelope: { format: 'beeflow-automation' },
            warnings: ['Removed x'],
        });
    });
});

describe('the catalog', () => {
    const RAW = {
        apps: [
            {
                id: 'gmail',
                label: 'Gmail',
                available: true,
                icon: 'mail',
                actions: [
                    { name: 'gmail_send', label: 'gmail send', inputSchema: { type: 'object', properties: { to: { type: 'string' } } }, sideEffect: true, effect: 'sends', futureField: 'kept' },
                    { label: 'no name' },
                ],
            },
            { label: 'no id' },
            'not a row',
        ],
        datatables: [{ id: 't1', name: 'Leads', managedKind: null, canWrite: 'yes', columns: [{ key: 'email', type: 'text' }, { type: 'x' }] }],
        knowledgeBases: [{ id: 'kb1', name: 'Docs', canWrite: false }],
        agents: null,
        agentsError: 'agent list unavailable',
        formPickSources: [{ id: 'fireflies', label: 'Fireflies', sampleData: { date: '2026-01-01' }, available: true }],
        steps: [{ id: 7, title: 'Reusable', available: true }],
        triggerOutputs: { 'gmail:mail.new': { fields: [{ key: 'subject' }] } },
        triggerMeta: [{ key: 'kind', path: 'trigger.kind', sample: 'manual' }, { path: 'no key' }],
        deliverability: { pollerBacked: { nextcloud: ['file.created'] } },
        stepTypes: ['trigger', 'code', 7],
        triggers: [{ kind: 'manual', label: 'Run manually' }, { kind: 'app_event', providers: [{ id: 'gmail' }] }],
        flags: { code: false, codeReason: 'platform', automations: true, newFlag: 1 },
        brandNewSection: { a: 1 },
    };

    it('checks the fields it names and keeps the ones it does not', () => {
        const catalog = readCatalog(RAW);
        expect(catalog.apps).toHaveLength(1);
        const app = catalog.apps[0]!;
        expect(app).toMatchObject({ id: 'gmail', label: 'Gmail', available: true, icon: 'mail' });
        expect(app.actions).toHaveLength(1);
        expect(app.actions[0]).toMatchObject({
            name: 'gmail_send',
            inputSchema: { type: 'object' },
            outputSchema: undefined,
            producesList: false,
            listField: null,
            sideEffect: true,
            effect: 'sends',
            integrationId: '',
            futureField: 'kept',
        });
        expect(catalog.datatables[0]).toMatchObject({ id: 't1', managedKind: undefined, canWrite: false });
        expect(catalog.datatables[0]?.columns).toEqual([{ key: 'email', type: 'text', name: undefined, unique: undefined }]);
        expect(catalog.agents).toEqual([]);
        expect(catalog.agentsError).toBe('agent list unavailable');
        expect(catalog.steps[0]?.id).toBe('7');
        expect(catalog.triggerMeta.map((m) => m.key)).toEqual(['kind']);
        expect(catalog.stepTypes).toEqual(['trigger', 'code']);
        expect(catalog.triggers.map((t) => t.kind)).toEqual(['manual', 'app_event']);
        expect(catalog.flags).toEqual({ code: false, codeReason: 'platform', automations: true, newFlag: 1 });
        expect(catalog.brandNewSection).toEqual({ a: 1 });
        expect(catalog.formPickSources[0]).toMatchObject({ id: 'fireflies', internal: false, sampleData: { date: '2026-01-01' } });
    });

    it('reads a payload that is not an object as an empty catalog', () => {
        const empty = readCatalog('<html>');
        expect(empty.apps).toEqual([]);
        expect(empty.flags).toEqual({ code: false, codeReason: null, automations: false });
        expect(empty.triggerOutputs).toEqual({});
    });

    it('reads the pick sources on their own', () => {
        expect(readPickSources({ sources: [{ id: 'a', label: 'A' }, { label: 'no id' }] }).map((s) => s.id)).toEqual(['a']);
    });
});

describe('versions', () => {
    it('lists metadata, reads one version and a diff', () => {
        expect(readVersionList({ versions: [{ id: 'v2', version: 2, savedByName: 'Tom' }, { version: 1 }] })).toEqual([
            {
                id: 'v2', automationId: '', version: 2, savedByUserId: null, savedAt: null, changeSummary: null, savedByName: 'Tom',
                name: null, description: null, descriptionJson: [], isLive: false, liveSince: null, isEditing: false, runs: null,
            },
        ]);
        // Handoff 5: a milestone name, the change codes (one entry or a list), the live and editing flags, run counts.
        const [live] = readVersionList({ versions: [{
            id: 'v3', version: 3, name: ' ', description: 'Changed "A"', descriptionJson: { code: 'step_changed', params: { step: 'A' } },
            isLive: true, liveSince: '2026-09-20T10:00:00Z', isEditing: 'yes', runs: { total: '4', failed: 1 },
        }] });
        expect(live).toMatchObject({
            name: null, description: 'Changed "A"', descriptionJson: [{ code: 'step_changed', params: { step: 'A' } }],
            isLive: true, liveSince: '2026-09-20T10:00:00Z', isEditing: false, runs: { total: 4, failed: 1 },
        });
        expect(readVersionList({ versions: [{ id: 'v1', version: 1, descriptionJson: [{ code: '' }, { code: 'created' }, 'x'] }] })[0]?.descriptionJson)
            .toEqual([{ code: 'created', params: {} }]);
        expect(readVersionResponse({ version: { id: 'v1', definition: null } })?.definition).toEqual({ trigger: null, steps: [], edges: [] });
        const diff = readVersionDiff({ a: { id: 'v1' }, b: null, summary: { steps: { added: ['s2'] }, edgesChanged: true } });
        expect(diff.a?.id).toBe('v1');
        expect(diff.b).toBeNull();
        expect(diff.summary).toEqual({ steps: { added: ['s2'], removed: [], changed: [] }, edgesChanged: true, triggerChanged: false });
    });
});

describe('webhooks, form links and folders', () => {
    it('a webhook list carries no secret; a create carries it once, with the URL from either place', () => {
        expect(readWebhookList({ webhooks: [{ id: 'slug', url: 'https://x/wh/slug', allowMethods: ['POST'] }, {}] })).toEqual([
            { id: 'slug', automationId: '', triggerStepId: null, url: 'https://x/wh/slug', allowMethods: ['POST'], lastSeenAt: null, createdAt: null, secret: null },
        ]);
        expect(readWebhookResponse({ webhook: { id: 'slug', secret: 's3cr3t' }, url: 'https://x/wh/slug' })).toMatchObject({
            secret: 's3cr3t',
            url: 'https://x/wh/slug',
        });
        expect(readWebhookResponse({})).toBeNull();
    });

    it('a form link defaults to the restricted audience', () => {
        expect(readFormLinkList({ forms: [{ id: 'tok', submissions: '4' }] })[0]).toMatchObject({ id: 'tok', submissions: 4, audience: 'restricted', sharedGroups: [] });
        expect(readFormLinkResponse({ form: { id: 'tok' }, url: 'https://x/f/tok' })?.url).toBe('https://x/f/tok');
    });

    it('folders, and how many automations a delete detached', () => {
        expect(readFolderList({ folders: [{ id: 'f1', name: 'Sales', automationCount: '2' }, { name: 'no id' }] })).toEqual([
            { id: 'f1', organizationId: null, name: 'Sales', icon: '📁', color: null, createdAt: null, updatedAt: null, automationCount: 2 },
        ]);
        expect(readFolderDeleted({ success: true, detached: 3 })).toBe(3);
    });
});

describe('templates and the agent capsule', () => {
    it('lists cards without definitions, and reads one template whole', () => {
        const list = readTemplateList({ templates: [{ id: 'nc-invoice-inbox', title: 'Invoice inbox', tags: ['gmail'], requiredIntegrations: ['gmail'] }, { title: 'x' }], categories: ['Files'] });
        expect(list.templates).toHaveLength(1);
        expect(list.templates[0]).toMatchObject({ icon: null, triggerReadiness: 'ready' });
        expect(list.categories).toEqual(['Files']);
        expect(readTemplateResponse({ template: { id: 't', definition: { steps: [{ id: 'a', type: 'set' }] } } })?.definition.edges).toEqual([]);
    });

    it('reads a refusal as canUse false with nothing else', () => {
        expect(readAgentPreview({ id: 'ag', canUse: false, permissions: { useTools: true }, allowed: [], withheld: [] })).toMatchObject({
            canUse: false,
            name: null,
            permissions: { useTools: true },
        });
        expect(readAgentPreview({ withheld: [{ name: 'gmail_send', reason: 'confirm' }, { reason: 'x' }] }).withheld).toEqual([
            { name: 'gmail_send', reason: 'confirm' },
        ]);
    });
});

describe('the builder session', () => {
    it('reads the conversation, the draft and the findings', () => {
        const snapshot = readBuilderSnapshot({
            sessionId: 'bs1',
            version: 4,
            draft: { trigger: { id: 'trg', type: 'trigger' } },
            lastValidation: { errors: [{ code: 'x', message: 'Broken', path: 'steps[s1]' }], warnings: null },
            summary: { summary: 'Sends a mail' },
            conversation: [
                { role: 'user', content: 'Make a flow' },
                { role: 'assistant', content: 'Done', toolCalls: [{ name: 'builder_add_steps', result: { error: 'refused' } }, { name: 'builder_finalize', result: {} }] },
                { role: 'system', content: 'dropped' },
            ],
            todos: [{ text: 'Add trigger', done: true }, { done: false }],
        });
        expect(snapshot.draft).toEqual({ trigger: { id: 'trg', type: 'trigger' }, steps: [], edges: [] });
        expect(snapshot.lastValidation?.errors[0]).toMatchObject({ severity: 'error', message: 'Broken' });
        expect(snapshot.summary).toBe('Sends a mail');
        expect(snapshot.conversation).toHaveLength(2);
        expect(snapshot.conversation[1]?.toolCalls).toEqual([
            { name: 'builder_add_steps', error: 'refused' },
            { name: 'builder_finalize', error: null },
        ]);
        expect(snapshot.todos).toEqual([{ text: 'Add trigger', done: true }]);
        expect(readBuilderSnapshot(null)).toMatchObject({ sessionId: null, draft: null, lastValidation: null, conversation: [] });
    });
});
